# 2026-06-15 — Production admin capabilities via per-user role gate

## Problem

All admin capabilities in the web frontend (the inline org / source / product /
release / collection admin menus, the `/admin` hub, the site-notice editor, and
the API-token tools) are gated by a single function, `isLocalAdminEnabled()`
(`web/src/lib/local-admin-flag.ts`):

```ts
export function isLocalAdminEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (process.env.VERCEL_ENV === "production") return false;
  return Boolean(serverApiKey());
}
```

In production this returns `false` for **everyone**, regardless of who is logged
in. The admin **server actions** authorize purely by holding the server-side
root `RELEASES_API_KEY` (via `adminActionEnv()`); they never look at the logged-in
user. That is exactly why they are hard-disabled in prod — enabling them as-is
would expose root-key power to any visitor.

We want a signed-in **admin** user to have these capabilities in deployed
production, without exposing them to non-admin users.

## What already exists

- `user.role` column (Better Auth admin plugin), values `user` / `curator` /
  `admin`, settable via `releases admin user set-role` (root-key gated).
- `ROLE_LADDER` (`workers/api/src/auth/entitlement.ts`) maps role → API scopes:
  `user → [read]`, `curator → [read, write]`, `admin → [read, write, admin]`.
- The `jwt()` plugin is already registered (`workers/api/src/auth/index.ts:839`).
  Its `GET /api/auth/token` endpoint mints a short-lived JWT for the current
  session — no OAuth authorization-code flow required.
- The API's resource-server lane already verifies such JWTs:
  `verifyOAuthJwt()` (`packages/lib/src/oauth-jwt.ts`) checks signature (via the
  same JWKS), `iss`, `aud`, `exp`, and maps the `scope` claim onto the
  `read ⊂ write ⊂ admin` ladder. Admin API routes require `admin` scope
  (`authMiddleware`, `workers/api/src/middleware/auth.ts`).
- A plain Better Auth **session cookie is never accepted** as a scoped principal
  on the REST API — only the root key, a `relk_` token, or an OAuth/JWT bearer.

## Approach: per-user JWT is the single authoritative gate

The signed-in user's JWT is minted server-side via `GET /api/auth/token` and used
to call the admin API route. The JWT's `scope` claim is **role-clamped at
issuance** (`definePayload` → `scopesForRole(user.role)`), so the API itself is
the authoritative check:

- An admin user's JWT carries `admin` scope → the admin route succeeds.
- A non-admin's JWT carries `read` (or `write` for a curator) → the admin-scoped
  route returns 403. The role model handles curators correctly: write-scoped
  edits succeed, admin-only operations 403.

This means **no separate server-side role check is needed** in the web action.
The verification gates below (now both resolved) confirmed the per-user JWT path
is sound, so the earlier two-layer design — an explicit `get-session` role check
in front of the JWT — was redundant and has been dropped. The minting _is_ the
gate. No shared `relk_`/root credential sits on the web server; the only
credential is the caller's own short-lived, role-clamped JWT.

UI gating (which menus render) is separate and client-side — see below — and is
cosmetic only: bypassing it just produces a 403 at the API.

## Scope

In scope (becomes available to admin-role users in prod):

- Inline entity admin menus: org, source, product, release, collection.
- The `/admin` hub and its tools: site-notice editor, API-token tools.

Out of scope (stays on its current `NODE_ENV`-only gate):

- Playbook viewer, fetch-log, the `/gh` GitHub-changelog parser, the status
  dashboard, and the `adminDocs` flag (`web/src/flags.ts`).

## Components

### 1. Role → scope helper

Add `scopesForRole(role: string | null | undefined): string[]` over the existing
`ROLE_LADDER` in `workers/api/src/auth/entitlement.ts`. Fail-closed: any
unrecognized / missing role returns `["read"]`. Reused by `definePayload`; no new
ladder is introduced.

### 2. API — `jwt()` plugin configuration

In `workers/api/src/auth/index.ts`, configure the already-registered `jwt()`
plugin:

- `jwt.definePayload` → emit a space-delimited `scope` claim from
  `scopesForRole(user.role)` **plus** the `https://releases.sh/role` claim. This
  role-clamp is the security boundary: a non-admin session can never receive a
  JWT carrying `admin` scope.
- `jwt.issuer = ${origin}/api/auth` (computed as
  `new URL(BETTER_AUTH_URL).origin + "/api/auth"`) and `jwt.audience = ${origin}`
  (bare origin) — matching exactly what `oauthJwtConfig()` checks. **`jwt.issuer`
  is required**: without it, the `/token` default issuer is the bare origin
  (`ctx.context.options.baseURL`), which the API's verifier rejects. Setting it to
  `${origin}/api/auth` is a **no-op for OAuth access tokens** — that is already
  their resolved `iss` (`ctx.context.baseURL` = baseURL + default basePath
  `/api/auth`) — so it fixes `/token` without disturbing the OAuth lane (verified;
  see Verification gates).
- `jwt.expirationTime` short (default 15m is fine; minted on demand per action).
- `disableSettingJwtHeader: true` — the scoped JWT is minted server-side only and
  must never be broadcast to the browser via the `set-auth-jwt` header on
  `getSession()`.

### 3. Web — UI gating (caching-preserving)

Do **not** move the UI gate to a server-side session read; that would force every
otherwise-cacheable org/release page to render dynamically.

- **Inline entity menus** gate **client-side** via `useSession()`: the menu
  component self-hides unless `data?.user?.role === "admin"`, OR a `devAdmin`
  boolean prop is true (preserves the keyless local-dev workflow, where
  `isLocalAdminEnabled()` is true but there may be no signed-in user). Server
  render stays static for anonymous visitors. The menu's presence in the client
  bundle is harmless — every action enforces server-side.
- **`/admin` hub page** (not cache-critical) gates **server-side**: `notFound()`
  unless the session role is admin or `isLocalAdminEnabled()`.
- **Header / account-nav "Admin" link** follows the same client role check.

Touch points (UI):

- `web/src/app/[orgSlug]/(org)/layout.tsx`
- `web/src/app/[orgSlug]/[slug]/layout.tsx`
- `web/src/app/sources/[id]/layout.tsx`
- `web/src/app/[orgSlug]/[slug]/_views/product-view.tsx`
- `web/src/app/release/[id]/page.tsx`
- `web/src/app/collections/[slug]/page.tsx`
- `web/src/app/admin/page.tsx`
- `web/src/components/header.tsx`, `web/src/components/account-nav.tsx`
- The `*-admin-menu.tsx` components gain an internal role self-check + `devAdmin`
  prop.

### 4. Web — admin action credential

Replace `adminActionEnv()` (`web/src/lib/admin-action.ts`) with
`getAdminApiAuth()` returning `{ apiUrl, bearer } | { error }`:

- **Local dev** (`isLocalAdminEnabled()` true): return today's path — `apiUrl` +
  the root `RELEASES_API_KEY` as `bearer`. Local workflow unchanged.
- **Production**: mint the per-user JWT by forwarding the request's `.releases.sh`
  cookie (`next/headers`) to `GET ${api}/api/auth/token`, and return the JWT as
  `bearer`. No session/role pre-check — the JWT is role-clamped at issuance and
  the API enforces scope. A missing/invalid session makes `/token` fail → return
  `{ error }`.

Admin actions (`web/src/app/actions/org-admin.ts`, `release-admin.ts`,
`site-notice.ts`, `api-tokens.ts`, and the source/product menus' actions) change
`Authorization: Bearer ${env.apiSecret}` → `Bearer ${env.bearer}`. The return
shape is otherwise preserved, so the edits are mechanical.

The cookie read only runs inside server actions (already dynamic), so it does not
deopt page caching. Implementation note to confirm: `GET /api/auth/token`
authenticates off the forwarded session cookie (no bearer plugin needed for the
cookie path).

### 5. Ops prerequisite

The target prod user's `user.role` must be set to `admin` once, via
`releases admin user set-role` (root-key gated).

## Verification gates — both RESOLVED ✅

Verified by reading the installed Better Auth source (`better-auth@1.6.18`,
`@better-auth/oauth-provider@1.6.18`).

1. **`/token` coexistence — PASS.** `GET /token` (jwt plugin) and
   `POST /oauth2/token` (oauth provider) are distinct routes, both registered
   unconditionally; no runtime conflict. `disableSettingJwtHeader` only controls
   the `set-auth-jwt` header on `/get-session`, not the `/token` route. The docs'
   "MUST disable `/token`" is a spec-compliance recommendation, not a hard break;
   keeping it on for first-party server-side use is a deliberate, contained choice.
2. **No payload bleed — PASS, with one required value.** Traced
   `createJwtAccessToken` → `signJWT`:
   - `definePayload` is **isolated** to `/token`; OAuth access tokens build their
     payload from `customAccessTokenClaims` and never call it.
   - `jwt.audience` does **not** reach OAuth tokens — they set `aud` explicitly
     from the request `resource`, so `signJWT` uses that over the plugin default.
   - `jwt.issuer` **does** feed OAuth tokens
     (`iss: jwtPluginOptions?.jwt?.issuer ?? ctx.context.baseURL`), but the
     current value is already `${origin}/api/auth` (`ctx.context.baseURL` =
     baseURL `https://api.releases.sh` + default basePath `/api/auth`). Setting
     `jwt.issuer` to exactly `${origin}/api/auth` is **required** to make `/token`
     tokens verify (their default would be the bare origin) and a **no-op** for
     OAuth tokens.

No fallback needed. (Had a gate failed, the fallback would have been a
server-side role check + a dedicated `relk_` admin token held server-side.)

## Error handling

Fail-closed throughout: missing session, non-admin role, or a failed token mint
returns an error from the action and renders no admin UI. The role-clamp in
`definePayload` defaults to `read` for unknown roles, so a non-admin can never
obtain an admin-scoped JWT even if a UI gate were bypassed.

## Testing

- **Unit:** `scopesForRole` fail-closed mapping (unknown/missing → `["read"]`);
  `definePayload` output shape (space-delimited scope + role claim);
  `getAdminApiAuth` returns an error when `/token` mint fails (no session).
- **Integration:** a JWT minted from `/api/auth/token` passes `verifyOAuthJwt`
  with `admin` scope for an admin-role session and `read` only for a `user`-role
  session; the same JWT authorizes an admin API route (e.g. `PATCH /v1/orgs/:slug`)
  for admin and 403s for `user`. **Regression:** an OAuth-provider access token's
  `iss`/`aud`/claims are unchanged after adding the `jwt` plugin config (guards
  the issuer no-op).
- **Manual:** signed in as admin in a prod-like build — menus appear, an action
  succeeds; signed in as a non-admin — no menus, and a forced action 403s.

## Out of scope / non-goals

- No changes to the experimental `NODE_ENV`-only pages.
- No new feature flag (per project convention — ship enabled, gated by role).
- No subscription/billing or curator (`write`) UI surfacing; this is admin-only.
