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

## Approach: two layers

**Layer 1 — server-side role check (authoritative).** Every admin server action
verifies the Better Auth session server-side and requires `user.role === "admin"`
before doing anything. This alone makes the system correct and safe: non-admins
are refused server-side and no privileged credential reaches the browser.

**Layer 2 — per-user JWT (defense-in-depth).** The action mints the signed-in
user's JWT via `GET /api/auth/token` and calls the admin API route with it, so
the API **independently** enforces admin per user.

Layering matters because Layer 2 is the only auth-critical surface (see
Verification gates). Making Layer 1 authoritative means correctness never depends
on Layer 2: if a gate fails, we ship Layer 1 with a shared `relk_` admin
credential and Layer 2 becomes a follow-up, with no change to the security
guarantee.

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
- `jwt.issuer = ${origin}/api/auth` and `jwt.audience = ${origin}` — derived from
  `BETTER_AUTH_URL`, matching exactly what `oauthJwtConfig()` checks (the #1483
  issuer-suffix detail; the bare-origin audience).
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
- **Production**: read the server session (forwarding `next/headers` cookies to
  `GET ${api}/api/auth/get-session`). If no session or `role !== "admin"` →
  `{ error }` (Layer 1). Otherwise mint the per-user JWT via
  `GET ${api}/api/auth/token` forwarding the same cookie, and return it as
  `bearer` (Layer 2).

Admin actions (`web/src/app/actions/org-admin.ts`, `release-admin.ts`,
`site-notice.ts`, `api-tokens.ts`, and the source/product menus' actions) change
`Authorization: Bearer ${env.apiSecret}` → `Bearer ${env.bearer}`. The return
shape is otherwise preserved, so the edits are mechanical.

The session-cookie read only runs inside server actions (already dynamic), so it
does not deopt page caching.

### 5. Ops prerequisite

The target prod user's `user.role` must be set to `admin` once, via
`releases admin user set-role` (root-key gated).

## Verification gates (must pass before Layer 2 code)

1. **`/token` coexistence.** Better Auth's docs say that in OAuth-provider mode
   (we run `oauthProvider()`) you "MUST disable the `/token` endpoint." We are
   deliberately keeping it on for first-party use. Verify that keeping `/token`
   on does not disturb the OAuth2/OIDC discovery document or the `oauth2/token`
   flow (different paths, but confirm no conflict).
2. **No payload bleed.** Verify that `jwt.definePayload` / `issuer` / `audience`
   overrides on the `jwt()` plugin do **not** alter the access tokens issued by
   `oauthProvider` (those are role-clamped separately via
   `customAccessTokenClaims`). If they share the signer's payload path, redesign
   around it.

If either gate fails: ship Layer 1 only, using a dedicated `relk_` admin token
held server-side (least-privilege vs. the literal root key) instead of the
per-user JWT. The security guarantee is unchanged; only the API-side
defense-in-depth is deferred.

## Error handling

Fail-closed throughout: missing session, non-admin role, or a failed token mint
returns an error from the action and renders no admin UI. The role-clamp in
`definePayload` defaults to `read` for unknown roles, so a non-admin can never
obtain an admin-scoped JWT even if a UI gate were bypassed.

## Testing

- **Unit:** `scopesForRole` fail-closed mapping; `getAdminApiAuth` refuses a
  non-admin / missing session; `definePayload` output shape (scope + role claim).
- **Integration:** a JWT minted from `/api/auth/token` passes `verifyOAuthJwt`
  with `admin` scope for an admin-role session and `read` only for a `user`-role
  session; the same JWT authorizes an admin API route (e.g. `PATCH /v1/orgs/:slug`).
- **Manual:** signed in as admin in a prod-like build — menus appear, an action
  succeeds; signed in as a non-admin — no menus, and the API returns 403.

## Out of scope / non-goals

- No changes to the experimental `NODE_ENV`-only pages.
- No new feature flag (per project convention — ship enabled, gated by role).
- No subscription/billing or curator (`write`) UI surfacing; this is admin-only.
