# OAuth Provider — Consent UI + Per-User Scope Entitlement (sub-projects 2 + 3)

- **Date:** 2026-06-07
- **Status:** Designed; pending implementation
- **Builds on:** `2026-06-07-oauth-provider-foundation-design.md` (sub-project 1, merged `6d290051` / #1479)

## Summary

The OAuth AS foundation (sub-project 1) is live but **inert**: it can mint JWTs
and serve discovery, but no end-user authorization flow can complete because
there is no consent page and no per-user entitlement model. This spec combines
the next two sub-projects into one unit, because the consent screen is
meaningless without the entitlement filter that decides which scopes it may
offer:

- **#2 — Per-user scope entitlement.** Decide which OAuth scopes
  (`read`/`write`/`admin`, plus the identity scopes) a signed-in human may
  consent to, enforced fail-closed at the AS.
- **#3 — Consent UI.** The `/oauth/consent` web page (on `releases.sh`) that
  shows the requesting client + the scopes the user is entitled to grant, and
  submits accept/deny.

Together these make the AS able to complete a real `authorization_code` + PKCE
flow for a human user (provable end-to-end with an admin-created client; public
dynamic registration remains off until sub-project 4).

Entitlement is modelled the **Better Auth way** — a `role` on the user via the
core `admin` plugin, mapped to a scope ceiling — not a bespoke entitlement
table. The `@better-auth/oauth-provider` plugin has **no per-user scope-filter
hook**, so enforcement lives in a `hooks.before` gate on `/oauth2/consent` plus a
`customAccessTokenClaims` backstop that runs on every token issuance.

## Context

The API worker (`workers/api`, `api.releases.sh`) hosts Better Auth at
`/api/auth/*`; `createAuth` (`workers/api/src/auth/index.ts`) builds the instance
per-request and (since #1479) registers `jwt()` + `oauthProvider()`. The auth
tables are a worker-local Drizzle schema island in
`workers/api/src/db/schema-auth.ts`, handed to `drizzleAdapter({ schema })`. The
web frontend (`web`, `releases.sh`) talks to the worker via the credentialed,
`.releases.sh`-scoped session cookie; its Better Auth browser client is
`web/src/lib/auth-client.ts`.

### Findings that drive this design (verified against the installed packages + docs)

1. **No human-role concept exists.** The `user` table
   (`schema-auth.ts`) has no role/curator/admin flag. Today "admin" means holding
   an admin-scoped _credential_; human users via the `relu_` lane are
   hard-clamped to `read` (`USER_API_KEY_MAX_SCOPE`). There is also **no
   user↔organization membership table** — so "org owner" entitlement has nothing
   to build on and is out of scope here.
2. **The `admin` plugin is core** (`better-auth/plugins`) — adopting it adds **no
   new dependency**. It adds `role` (default `"user"`), `banned`, `banReason`,
   `banExpires` to `user` and `impersonatedBy` to `session`, and exposes
   `setRole`/`listUsers`/ban/impersonate (admin-gated). `role` is returned on
   `session.user` at runtime. Custom roles use `createAccessControl`
   (`better-auth/plugins/access`).
3. **The oauth-provider plugin has no per-user scope-filter hook.** Its consent
   endpoint only checks the submitted `scope` is a subset of what was _requested_
   (`dist/index.mjs` consent handler), never an entitlement ceiling. Available
   hooks: `customAccessTokenClaims(info)`, `customIdTokenClaims`,
   `customUserInfoClaims`, `clientPrivileges`, `postLogin.*`, `scopes`,
   `consentPage`, `loginPage`. `customAccessTokenClaims` is invoked at token
   issuance (and introspection) and **may throw** to abort issuance.
4. **`loginPage`/`consentPage` are used verbatim.** The plugin builds the redirect
   by pure string concatenation (`` `${page}?${queryParams}` ``) and hands it to
   `ctx.redirect` unchanged — no resolution against the AS base URL. A relative
   `"/oauth/consent"` therefore resolves (in the browser) against the request
   origin = `api.releases.sh` (the wrong worker). The pages live on `releases.sh`,
   so these **must be absolute web-origin URLs** — the same class of bug already
   handled for the device-auth `verificationUri` (`index.ts` precedent;
   `WEB_BASE_URL` already exists, default `https://releases.sh`). The foundation
   set them as relative paths; that latent bug never surfaced because the AS was
   inert. **This spec folds the fix in.**
5. **The consent page receives the full signed authorize query** — `client_id`,
   `scope`, `redirect_uri`, `state`, `response_type`, `code_challenge`,
   `code_challenge_method`, plus `exp` and `sig` (HMAC over the params). The page
   must echo this whole query string back as `oauth_query` when calling
   `/oauth2/consent`.
6. **First-admin bootstrap** is `adminUserIds` (config array, short-circuits
   `hasPermission` regardless of the DB `role`) — no DB write required to unlock
   the first admin, who then `setRole`s others.

### Recorded decisions (this spec)

1. **One combined spec → plan → PR** for #2 + #3.
2. **Entitlement lives on the user `role` (core `admin` plugin)** — idiomatic
   Better Auth, no bespoke table. Roles: `user`/`curator`/`admin`.
3. **No feature flag** — consent + entitlement ship always-on. The entitlement
   gate only ever _tightens_, so it is safe always-on; the consent page is
   reachable only via the AS redirect, and the AS stays inert until a client is
   provisioned (matches the #1 "no feature flag" rationale).
4. **Org-scoped entitlement, role-management UI, DCR/trusted clients, and
   resource-server verification are out of scope** (later sub-projects / HELD).

## Goals

- Adopt the `admin` plugin (+ `createAccessControl` roles) and the five
  Better-Auth columns + paired migration.
- A single source-of-truth entitlement module mapping `role` → grantable OAuth
  scopes, fail-closed.
- Enforce the per-user scope ceiling at the consent gate **and** at token
  issuance (universal backstop).
- Stamp the user's role into the issued JWT.
- Fix `loginPage`/`consentPage` to absolute web-origin URLs.
- Build the `/oauth/consent` web page + wire `oauthProviderClient()`.

## Non-goals (later sub-projects)

- Dynamic client registration / trusted-client provisioning beyond an
  admin-created test client (sub-project 4).
- Resource-server JWT verification in the MCP worker + REST middleware
  (sub-project 5).
- Organization plugin / org-scoped entitlement (HELD).
- A web admin UI for managing roles (roles are set via the admin plugin's
  `setRole` endpoint or `adminUserIds` bootstrap; no new screen here).
- Consent scope-narrowing checkboxes (Allow grants the entitled∩requested set
  wholesale; narrowing is a later enhancement).
- Any change to the existing `relu_`/`relk_`/anonymous credential lanes.

## Design

### 1. Adopt the `admin` plugin + roles (`workers/api/src/auth/index.ts`)

Register the core `admin` plugin in the `createAuth` `plugins` array (always-on,
no flag). Define roles via `createAccessControl`, merging the admin plugin's own
statements so the `admin` role retains its user-management powers:

```ts
import { admin } from "better-auth/plugins";
import { adminAc, userAc } from "better-auth/plugins/admin/access";

admin({
  // Reuse Better Auth's built-in admin/user roles. `curator` mirrors `user` for
  // admin-plugin permissions (it grants NO user-management powers); its only
  // meaning is the OAuth scope ceiling in entitlement.ts (ROLE_LADDER). No custom
  // createAccessControl is needed — entitlement is a plain map, not the AC system.
  roles: { admin: adminAc, user: userAc, curator: userAc },
  adminRoles: ["admin"],      // only the `admin` role hits admin-plugin endpoints
  defaultRole: "user",        // new sign-ups are read-only
  adminUserIds: oauthAdminUserIds(env), // bootstrap; see §5
}),
```

`adminAc`/`userAc` are the built-in roles exported by
`better-auth/plugins/admin/access`. Registering `curator: userAc` makes `setRole`
accept `"curator"` while granting it no admin powers. Placement: alongside the
other always-on plugins, near `jwt()`/`oauthProvider()`.

### 2. Schema + migration

Add the admin-plugin columns to `schema-auth.ts`, following the file's Better
Auth convention (snake_case SQL, camelCase JS keys, integer `boolean`/`timestamp`
modes):

- `user`: `role text` (default `'user'`), `banned integer` (boolean),
  `banReason text`, `banExpires integer` (timestamp).
- `session`: `impersonatedBy text`.

Paired migration `workers/api/migrations/20260607010000_add_admin_plugin.sql`
(`ALTER TABLE user ADD COLUMN ...` ×4, `ALTER TABLE session ADD COLUMN
impersonated_by text`). The schema↔migration pairing CI gate watches
`schema-auth.ts`, so the migration lands in the same change. The admin plugin
declares `role` with **no schema-level default** (it stamps `"user"` at runtime in
its user-create hook), so `role` is a nullable column; existing prod rows stay
`NULL` → `entitledScopes(null)` returns read-only (fail-closed). Reconcile exact
column/field names with the installed admin-plugin schema at implementation time
(same discipline as #1).

### 3. Entitlement module (`workers/api/src/auth/entitlement.ts`)

The single source of truth, pure + unit-testable, imported by the enforcement
seams (§4). It is a plain scope map — **not** the Better Auth access-control
system (the AC governs admin-plugin endpoints, not OAuth scopes):

```ts
// Identity scopes everyone who signs in may grant.
export const IDENTITY_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

// The API scope ladder, per role. Cumulative (read ⊂ write ⊂ admin).
export const ROLE_LADDER: Record<string, readonly string[]> = {
  user: ["read"],
  curator: ["read", "write"],
  admin: ["read", "write", "admin"],
};

/** Scopes a user with `role` may consent to. Unknown/null role → read-only (fail-closed). */
export function entitledScopes(role: string | null | undefined): string[] {
  // role may be a comma-separated multi-role string (admin-plugin convention).
  const roles = (role ?? "user")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  const ladder = new Set<string>();
  for (const r of roles) for (const s of ROLE_LADDER[r] ?? ROLE_LADDER.user) ladder.add(s);
  if (ladder.size === 0) for (const s of ROLE_LADDER.user) ladder.add(s);
  return [...IDENTITY_SCOPES, ...ladder];
}

/** Throws if any requested scope exceeds the role's entitlement. */
export function assertScopesEntitled(role: string | null | undefined, requested: string[]): void {
  const allowed = new Set(entitledScopes(role));
  const forbidden = requested.filter((s) => !allowed.has(s));
  if (forbidden.length) {
    throw new Error(`scopes not entitled for role ${role ?? "user"}: ${forbidden.join(", ")}`);
  }
}
```

The web consent page keeps a small mirror of `ROLE_LADDER` + `IDENTITY_SCOPES`
for display filtering only — the API gates below are the security boundary.

### 4. Enforcement — fail-closed, two layers (`workers/api/src/auth/index.ts`)

**Layer 1 — `hooks.before` on `/oauth2/consent`** (primary gate, before consent
is persisted):

```ts
import { createAuthMiddleware, APIError } from "better-auth/api";

hooks: {
  before: createAuthMiddleware(async (ctx) => {
    if (ctx.path !== "/oauth2/consent") return;
    const session = ctx.context.session ?? (await getSessionFromCtx(ctx));
    const requested = String(ctx.body?.scope ?? "").split(/\s+/).filter(Boolean);
    try {
      assertScopesEntitled(session?.user?.role, requested);
    } catch {
      throw new APIError("BAD_REQUEST", { error: "invalid_scope" });
    }
  }),
},
```

(If `createAuth` already passes a `hooks.before`, extend it by branching on
`ctx.path`; Better Auth takes a single `before`/`after` function, not an array.)

**Layer 2 — `customAccessTokenClaims`** on `oauthProvider` (universal backstop +
role claim). Runs at _every_ token issuance — including `skip_consent` trusted
clients and refresh-token replay — so no token can carry scopes beyond the
user's live entitlement, regardless of path:

```ts
customAccessTokenClaims: async ({ user, scopes }) => {
  // Backstop: re-assert against the CURRENT role (covers downgrades + skip_consent).
  assertScopesEntitled(user?.role, (scopes ?? []).filter((s) => !IDENTITY_SCOPES.includes(s)));
  return { "https://releases.sh/role": user?.role ?? "user" };
},
```

Together: the consent hook is the friendly early rejection for interactive flows;
the claims backstop is the hard guarantee that holds even when consent is
bypassed. Verify at implementation time that a throw in `customAccessTokenClaims`
aborts issuance on the refresh path (docs say it does; confirm in the dist).

### 5. Config: absolute page URLs + admin bootstrap

In the existing `oauthProvider({...})` block, change the relative pages to
absolute web-origin URLs (folded-in precursor fix, §Findings 4):

```ts
loginPage: `${env.WEB_BASE_URL ?? "https://releases.sh"}/login`,
consentPage: `${env.WEB_BASE_URL ?? "https://releases.sh"}/oauth/consent`,
```

`WEB_BASE_URL` is already a binding (default `https://releases.sh`; the portless
web origin locally; `api-staging`'s web host in staging). The session cookie is
`.releases.sh`-scoped so it rides across the two subdomains.

**Admin bootstrap.** Add a small `oauthAdminUserIds(env): string[]` helper
(parses a new optional comma-separated var `OAUTH_ADMIN_USER_IDS`) feeding
`admin({ adminUserIds })`. This unlocks the first admin without a DB write; that
operator then calls `setRole` to persist `role = 'admin'`/`'curator'` on the
target users — and **entitlement reads only the persisted `role` column** (single
source of truth; `adminUserIds` is purely the bootstrap to unlock `setRole`).
`.env`/`.dev.vars` are not edited by this change — the operator sets
`OAUTH_ADMIN_USER_IDS` (and runs the one-time `setRole`) themselves.

### 6. Consent web page (`web`)

**Client wiring** — add `oauthProviderClient()` to `web/src/lib/auth-client.ts`
(`@better-auth/oauth-provider/client`, a new web dependency; the `/client`
subpath is browser-safe). It exposes the typed consent/public-client methods.

**Route** — `web/src/app/oauth/consent/page.tsx` (App Router). No feature flag.
Server component renders the page chrome (Header + the existing `max-w` grid +
bordered stone card, matching `login`/`device` pages) and a `"use client"` form.
If there is no session the page links to `/login` (the AS redirect chain via
`loginPage` normally ensures a session first).

**Behaviour (client form):**

1. Read the signed OAuth params from `useSearchParams()` (keep the raw query
   string verbatim for `oauth_query`).
2. Fetch public client info via the oauth-provider client
   (`GET /api/auth/oauth2/public-client?client_id=…`) → `client_name`, `icon`,
   `uri`, `tos`, `policy`.
3. Read `session.user.role` (`authClient.getSession()`); compute display scopes =
   `requested ∩ entitledScopes(role)` via the web-local ladder mirror, rendered
   with friendly labels (`read` → "Read your catalog data", etc.).
4. **Allow** → `authClient.oauth2.consent({ accept: true, scope: granted.join(" "),
oauth_query })`; **Deny** → `{ accept: false, oauth_query }`. Follow the
   returned redirect to the client's `redirect_uri`.

Styling is hand-written Tailwind (stone palette, `dark:` variants), consistent
with the existing auth pages. No new component library.

## Data flow

```
client → GET api.releases.sh/api/auth/oauth2/authorize?client_id&scope&PKCE…
  AS: no session?  → 302 ${WEB_BASE_URL}/login            (absolute, §5)
  AS: session, consent needed → 302 ${WEB_BASE_URL}/oauth/consent?…signed…
browser → releases.sh/oauth/consent
  page: GET /api/auth/oauth2/public-client?client_id → client identity
  page: getSession → user.role → show requested ∩ entitled scopes
  user clicks Allow → POST /api/auth/oauth2/consent {accept, scope, oauth_query}
    AS hooks.before(/oauth2/consent): assertScopesEntitled(role, scope) | 400 invalid_scope
    AS persists consent, 302 → client redirect_uri?code=…
client → POST /api/auth/oauth2/token (code + PKCE verifier)
    AS customAccessTokenClaims: assertScopesEntitled(role, scopes) backstop + role claim
    → JWT access token (iss=api.releases.sh, aud, scope, role claim) + refresh (relo_)
```

## Security considerations

- **Fail-closed entitlement.** Unknown/missing role → read-only. Enforced at the
  consent gate (before persistence) and re-checked at every token issuance.
- **Backstop covers non-interactive paths.** `customAccessTokenClaims` throws on
  any scope beyond the user's current role, so a `skip_consent` client, a
  role downgrade after consent, or a refresh-token replay cannot widen scope.
- **Absolute page URLs** keep the browser on `releases.sh` for login/consent;
  the signed `sig`/`exp` on the redirect query prevent tampering with the pending
  request.
- **Admin surface.** Adopting the admin plugin exposes `setRole`/`listUsers`/ban
  endpoints, gated to the `admin` role + `adminUserIds`. No public role
  management; bootstrap is an explicit operator action.
- **Identity scopes** (`openid`/`profile`/`email`/`offline_access`) are grantable
  by everyone; only the `read`/`write`/`admin` ladder is entitlement-gated.

## Testing / acceptance

- **Unit** (`entitlement.test.ts`): `entitledScopes` per role; null/unknown →
  read-only; `assertScopesEntitled` throws on over-broad; identity scopes always
  allowed.
- **Schema**: the five new columns round-trip; the migration applies on a fresh
  test DB.
- **Wiring**: `createAuth` builds with the admin plugin registered; `hooks.before`
  present; `loginPage`/`consentPage` are absolute `https://…releases…/` URLs;
  `customAccessTokenClaims` returns the role claim.
- **Integration** (mirrors the #1 adapter-mapping test — admin-created client +
  test users, full authorize → consent → token):
  - a `user`-role user is denied `write` at the consent gate (`400 invalid_scope`)
    **and** at the claims backstop;
  - a `curator`-role user obtains `write`; the issued JWT carries the role claim
    and the expected `iss`/`aud`/scopes; verifies against `/api/auth/jwks`.
- **Web**: a light component/render test of the consent page if web test infra
  exists (confirm during planning); otherwise covered by the staging smoke.
- `npx tsc --noEmit` (root + `workers/api` + `web`), `bun test`, `bun run lint`,
  `bun run format:check` all green.
- **Staging smoke**: deploy; set `OAUTH_ADMIN_USER_IDS` + `setRole` a curator;
  admin-create a (non-`skip_consent`) client; drive the live `/oauth/consent`
  page through an `authorization_code` + PKCE exchange; verify the JWT. (The
  staging access gate requires `X-Releases-Staging-Key`.)

## Risks & open items

- **`hooks.before` composition.** If `createAuth` already sets `hooks`, extend the
  single `before` function by branching on `ctx.path` (Better Auth takes one
  function, not an array). Verify no existing hook is clobbered.
- **`customAccessTokenClaims` on refresh.** Confirm a throw there aborts issuance
  on the refresh-token path (not just the initial code exchange) before relying on
  it as the universal backstop; if not, add a `hooks.before` on the token path too.
- **Admin-plugin field reconciliation.** Match the exact column/field names to the
  installed admin-plugin schema (`@better-auth/cli generate`) rather than the
  draft above.
- **Web dependency.** Adding `@better-auth/oauth-provider/client` to the web
  bundle — confirm the `/client` subpath pulls no server-only code and the web
  `tsc`/build stays green. Fallback: drive the two endpoints via
  `authClient.$fetch` without the client plugin.
- **oauth-provider endpoint paths.** Confirm the exact `oauth2/consent` body
  fields and the `oauth2/public-client` query/return shape against the installed
  dist before building the form.

## Relationship to the five-sub-project plan

Sub-projects 2 (entitlement) + 3 (consent UI) of 5. With these merged, the AS can
complete a human `authorization_code` + PKCE flow for an admin-provisioned client.
Remaining: **4** — dynamic client registration + trusted (`skip_consent`) client
provisioning; **5** — MCP + REST as resource servers verifying the issued JWTs
(MCP via `jose`/JWKS, **no `better-auth` import** — zod-split landmine).
