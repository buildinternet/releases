# RAL-1484 — OAuth role provisioning (replace `OAUTH_ADMIN_USER_IDS`)

**Issue:** [#1484](https://github.com/buildinternet/releases/issues/1484) — prerequisite for OAuth phases 4 (#1482) and 5 (#1483).

## Problem

The only way to grant a user OAuth admin standing today is the comma-separated
`OAUTH_ADMIN_USER_IDS` env var. It is brittle: a redeploy to change, no audit
trail, opaque user IDs, and — critically — it only makes a user count as admin
for the Better Auth admin _plugin's own endpoints_ (e.g. `setRole`). It does
**not** set the durable `user.role` column, which is what OAuth scope
entitlement actually reads (`auth/entitlement.ts` → `ROLE_LADDER`). So an
env-listed user can call admin endpoints yet still receive read-only OAuth
tokens. We need operators to manage the `role` column directly, without a
redeploy, with an audit trail — before there's anything to authorize in phases
4/5.

## Decisions (resolved with the user)

1. **"operator" is a synonym for `admin`.** The ladder stays `{user, curator,
admin}` (user→read, curator→read+write, admin→read+write+admin). There is no
   OAuth scope tier between `write` and `admin` for a distinct "operator" to
   occupy, so we do not invent one. **`entitlement.ts` is untouched** — the
   security boundary and the #1481 drift gate are unaffected.
2. **Mechanism: a root-key-gated admin REST route + a CLI verb.** The route
   writes the `role` column directly; the CLI authenticates with the static
   root key (it has no browser session). No deploy-time auto-seed.
3. **`OAUTH_ADMIN_USER_IDS` is removed entirely.** It is unset in every deployed
   environment today, so removal is a runtime no-op. The static root key is the
   break-glass channel; once the first admin's `role` column is `admin`, the
   admin plugin authorizes them for native `setRole` too.
4. **Bootstrap only `dunn.zach@gmail.com` → admin.** Other grants happen later
   through the new mechanism.

### Approach rejected

Leaning on Better Auth's native `admin.setRole` as the sole mechanism. It
requires a logged-in **browser admin session**; the CLI uses the static root
key, and there is no web role-management UI yet (that is the issue's "option 3,
later"). Native `setRole` remains available for browser admins once a role=admin
user exists — the two coexist — but we do not depend on it.

### Why this does not widen the trust boundary

The static `RELEASES_API_KEY` already gates every destructive `/v1/admin/*`
route ("implicit root"). Adding a role-write under the same gate grants nothing
a root-key holder could not already do. Validation is fail-closed: unknown role
→ 400, missing user → 404, never defaults to admin.

## Components

### 1. New route module — `workers/api/src/routes/admin-users.ts`

- **`PATCH /v1/admin/users/role`** — body `{ email?, userId?, role }` with
  exactly one identifier. Resolves the user, writes `user.role` via Drizzle,
  emits the audit event, returns `{ userId, email, previousRole, role }`.
- **`GET /v1/admin/users/role?email=|userId=`** — read one user's current role
  (lets the CLI show before/after).
- **`GET /v1/admin/users/roles`** — list users whose role is `curator`/`admin`
  (at-a-glance "who has what" — serves the audit-trail acceptance criterion).

**Validation (fail-closed):** the accepted role set is
`Object.keys(ROLE_LADDER)` imported from `entitlement.ts` → `{user, curator,
admin}`, so the route can never drift from the scope boundary. Unknown/absent
role → `400`. Exactly-one-of `email`/`userId` required → `400` otherwise.
User not found → `404`. "Revoke" = set role to `user` (explicit read-only;
equivalent to NULL for entitlement).

**Audit:** `logEvent("info", { component: "auth", event: "role-changed",
targetUserId, targetEmail, fromRole, toRole, actor: "root-key" })` →
queryable in Axiom (`releases-cloudflare-logs`). Emitted only after a
successful write.

### 2. Registration

- Add `"admin/users"` to `adminRoutes` in
  `workers/api/src/route-namespaces.ts` → it inherits the root-key
  `authMiddleware` + admin CORS automatically (same loop as every other admin
  namespace in `index.ts`).
- Mount `adminUsersRoutes` alongside the other `admin-*` route modules in
  `workers/api/src/v1-routes.ts`.
- **No OpenAPI annotations needed:** the coverage gate
  (`scripts/check-openapi-coverage.ts`) only checks `publicReadRoutes` prefixes,
  not `adminRoutes`.

### 3. Remove `OAUTH_ADMIN_USER_IDS`

- `workers/api/src/auth/index.ts`: delete the `oauthAdminUserIds` helper and the
  `adminUserIds:` line from the `admin()` registration. Keep
  `roles`/`adminRoles`/`defaultRole`.
- `workers/api/src/index.ts`: drop the `OAUTH_ADMIN_USER_IDS?: string` binding.
- `workers/api/test/oauth-entitlement.test.ts`: remove the `oauthAdminUserIds`
  describe block and the import of that symbol.
- No `wrangler.jsonc`/`.env` edits required — the var is not set anywhere.

### 4. First-admin bootstrap (one-time, manual)

Direct prod D1 write, runnable now, independent of deploy timing:

```bash
set -a; . ./.env; set +a   # loads CLOUDFLARE_ACCOUNT_ID (Build Internet) — required for non-interactive prod D1
bunx wrangler d1 execute released-db \
  --remote --config workers/api/wrangler.jsonc \
  --command "UPDATE user SET role='admin' WHERE email='dunn.zach@gmail.com';"
```

Verify with a follow-up `SELECT id, email, role FROM user WHERE
email='dunn.zach@gmail.com';`. Reversible (`role='user'`).

### 5. CLI verbs (separate PR, `~/Code/releases-cli`)

Under the existing `admin` namespace, hitting the new route with the root key:

- `releases admin user set-role --email <e> --role <user|curator|admin>`
  (also accept `--user-id`).
- `releases admin user get-role --email <e>` (also `--user-id`), and a
  `list-roles` that calls `GET /admin/users/roles`.

Shows `previousRole → role` on success. CLI-only; not exposed via MCP/typed
tools (matches the prior `admin`-namespace convention).

## Sequencing

1. **Monorepo PR** — route + registration + env-var removal + tests + docs.
   Auto-deploys on merge.
2. **Seed** `dunn.zach@gmail.com` → admin (direct D1; user has pre-approved
   direct ID edits in scope).
3. **CLI PR** — the `admin user` verbs.

## Testing

New `workers/api/test/admin-users.test.ts`:

- `PATCH` set role happy path (user→curator, →admin, →user revoke).
- Unknown role → 400.
- Neither / both of `email`+`userId` → 400.
- Missing user → 404.
- `GET /role` reflects the write.
- `GET /roles` lists only curator/admin users.
- Audit event emitted on success (capture via the route's injectable logger or
  assert through the test harness, matching the admin-cron-runs test-injection
  pattern).

Existing `oauth-entitlement.test.ts` stays green after the
`oauthAdminUserIds` block is removed (`entitlement.ts` is unchanged).

## Docs

- `docs/architecture/remote-mode.md` (Auth model) — document the role
  provisioning route + CLI verb as the way to grant/revoke admin/curator, and
  note `OAUTH_ADMIN_USER_IDS` is gone.
- `AGENTS.md` — update the scoped-token/auth conventions line if it references
  the env-var bootstrap.

## Acceptance (issue #1484)

- [x] Operators grant/revoke `admin`/`curator` without a redeploy, audited →
      route + CLI verb + `logEvent`.
- [x] First admin bootstrapped cleanly → direct D1 seed.
- [x] `role` (the OAuth scope source of truth) is what's managed.
- [x] `OAUTH_ADMIN_USER_IDS` removed.
- [x] Existing email/password sign-in and the merged OAuth flow unaffected
      (`entitlement.ts` and `admin()` roles untouched).
