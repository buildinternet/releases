# OAuth Provider — AS Foundation (sub-project 1)

- **Date:** 2026-06-07
- **Status:** Design approved; spec under review
- **Worktree/branch:** `worktree-oauth-provider-foundation`

## Summary

Make the API worker's Better Auth instance an OAuth 2.0 / OIDC **authorization
server (AS)** by adding the `@better-auth/oauth-provider` plugin (plus its
required `jwt()` companion). This is the first of five sub-projects toward a
general "Sign in with Releases" provider whose first consumer is the remote MCP
server.

This sub-project delivers only the issuing/discovery plumbing: the AS can mint
JWT access tokens and serves OAuth/OIDC discovery metadata. It is **inert by
default** — with dynamic client registration off and no consent page yet, no
client can complete a flow until an admin provisions a trusted (`skip_consent`)
client. Consent UI, public client registration, the per-user scope-entitlement
model, and resource-server token verification are explicit non-goals here (see
[Decomposition](#decomposition)).

## Context

The API worker (`workers/api`, `api.releases.sh`) already hosts Better Auth at
`/api/auth/*` (Drizzle/D1) with email+password, magic link, gated social
providers, device authorization (RFC 8628), user API keys (`@better-auth/api-key`,
`relu_`), and the hosted `dash` plugin. Construction lives in
`workers/api/src/auth/index.ts` (`createAuth`), built per-request from env
bindings; the Drizzle/SQLite auth tables are a worker-local schema island in
`workers/api/src/db/schema-auth.ts`, handed directly to `drizzleAdapter({ schema })`.

The MCP server is a **separate** worker (`workers/mcp`, `mcp.releases.sh`) using
`createMcpHandler` from `agents/mcp`, with Bearer-token auth today (`relu_` user
keys, `relk_` machine tokens, static root key, else anonymous-read). That
separation is exactly Better Auth's "remote resource server" topology: the AS
plugin belongs in the API worker; the MCP worker verifies issued tokens (a later
sub-project).

### Recorded decisions (drive all five sub-projects)

1. **Goal:** a general OAuth/OIDC authorization server ("Sign in with Releases"),
   not an MCP-only shim. → Use `@better-auth/oauth-provider`, **not** the
   deprecated `mcp` plugin.
2. **Token grant model:** identity **plus** the existing API scope ladder. OAuth
   scopes map onto `read`/`write`/`admin` so a token authorizes the same API +
   MCP operations a `relk_`/`relu_` credential does, tied to the signed-in user.
3. **Per-user ceiling:** a per-user entitlement model — everyone gets
   `read` + identity; `write`/`admin` only for curator/admin-flagged users or
   org owners; the consent screen offers only entitled scopes. (Built in
   sub-project 2; this foundation only _declares_ the scopes.)
4. **Token type:** **JWT** access tokens (not opaque) so a remote resource server
   verifies locally against JWKS with no DB hit and no client secret.

## Goals

- Add `jwt()` + `oauthProvider()` to `createAuth`, always-on (no feature flag).
- Add the five new auth tables + a paired migration.
- Expose OAuth/OIDC discovery metadata at both the Better Auth path and the apex
  `.well-known/*` paths OAuth clients fetch.
- Keep the AS inert until an admin provisions a client.

## Non-goals (later sub-projects)

- Consent / authorization web UI (sub-project 3).
- Dynamic client registration enablement for public MCP clients (sub-project 4).
- Per-user scope-entitlement filtering at authorize/consent time (sub-project 2).
- Resource-server verification: `relo_`/OAuth-JWT acceptance in the MCP worker
  and the REST `/v1/*` middleware, and `.well-known/oauth-protected-resource`
  (sub-project 5).
- Any change to the existing `relu_`/`relk_`/anonymous lanes.

## Design

### 1. Plugin wiring (`workers/api/src/auth/index.ts`)

Add two plugins to `createAuth`'s `plugins` array, **always registered** (see
[No feature flag](#no-feature-flag) for why a kill switch is unnecessary):

- **`jwt()`** from `better-auth/plugins` — required companion of the OAuth
  provider. Signs JWT access tokens and exposes JWKS at `/api/auth/jwks`. It
  generates its own signing keypair and stores it (encrypted with the existing
  `BETTER_AUTH_SECRET`) in a new `jwks` table. **No new secret is required.**
- **`oauthProvider()`** from `@better-auth/oauth-provider` — a new dependency in
  `workers/api/package.json`, pinned to match `better-auth` (`^1.6.14`).

`@better-auth/oauth-provider` is a separate npm package (same split-package
pattern as the existing `@better-auth/api-key` / `@better-auth/infra`). It is
added only to `workers/api`, where root zod is already `^4.4.3` (the device-auth
plugin forced that bump), so it introduces **no new zod risk**. It is **not**
added to `workers/mcp`, which has no `better-auth` dependency and a pinned zod —
keeping it out of that worker avoids a zod split (the MCP worker's later
resource-server role verifies JWTs minimally via `jose`/JWKS, sub-project 5).

**`oauthProvider()` config:**

```ts
oauthProvider({
  loginPage: "/sign-in", // reuse the existing web sign-in page
  consentPage: "/oauth/consent", // declared now; page is sub-project 3
  scopes: [
    "openid",
    "profile",
    "email",
    "offline_access",
    "read",
    "write",
    "admin", // the Releases API scope ladder
  ],
  validAudiences: oauthValidAudiences(env), // [API origin, MCP origin] — see §4
  allowDynamicClientRegistration: false, // OFF here; sub-project 4 enables it
  prefix: { refreshToken: "relo_", clientSecret: "reloc_" },
  // JWT access tokens (jwt() present → not opaque), PKCE required for public
  // clients, default lifetimes: access 1h / refresh 30d / code 10m / id 10h.
});
```

Notes:

- `jwt()` is left at defaults; its presence (and _not_ setting
  `disableJwtPlugin`) is what makes access tokens JWTs.
- Token/credential **prefixes are set-once** before first deploy (changing them
  later orphans live tokens). `relo_` (refresh) / `reloc_` (client secret)
  extend the existing `relk_`/`relu_` family. Access tokens are JWTs and carry no
  prefix.
- With DCR off and no consent page, only an admin-created client with
  `skip_consent: true` (via `auth.api.adminCreateOAuthClient`) can complete a
  flow — this is the foundation smoke test, not a shipped user path.

### 2. Schema + migration

Add five Drizzle tables to `workers/api/src/db/schema-auth.ts`, following the
file's established Better Auth convention (snake_case column names, camelCase JS
keys, integer `timestamp`-mode columns, integer `boolean`-mode columns, and
`string[]` columns stored as JSON **text**):

- `oauthClient` — registered OAuth clients (`clientId`, optional `clientSecret`,
  `redirectUris`, `scopes`, `grantTypes`, `tokenEndpointAuthMethod`, `public`,
  `requirePKCE`, `skipConsent`, `userId`/`referenceId` ownership, display
  metadata, …).
- `oauthAccessToken` — **opaque** access tokens only (JWTs are self-contained and
  store no row); present because revocation/introspection of any future opaque
  tokens needs it.
- `oauthRefreshToken` — refresh tokens (hashed/encrypted), `clientId`, `userId`,
  `sessionId`, `scopes`, `expiresAt`, `revoked`, `authTime`.
- `oauthConsent` — per-user, per-client granted scopes.
- `jwks` — the `jwt()` plugin's signing keyset.

Register all five in the `drizzleAdapter({ schema })` map in `createAuth` (the
adapter resolves models by camelCase key; the SQL table names stay snake_case,
mirroring how `rateLimit`/`deviceCode` are handled).

**The exact column set is reconciled with `@better-auth/cli generate`** at
implementation time — per the convention comment already in `schema-auth.ts`, the
CLI is the source of truth; the field lists above and in the design discussion
are the starting point, then translated into the repo's Drizzle shape.

Paired migration: `workers/api/migrations/20260607000000_add_oauth_provider.sql`
(creates the five tables + their indexes). The schema↔migration pairing CI gate
watches `schema-auth.ts`, so the migration must land in the same change. Local
D1 does not auto-apply migrations — after merge, `bun run db:reset:local` rebuilds
local; prod/staging apply on deploy.

### 3. Discovery routing (`workers/api/src/index.ts`)

Better Auth auto-serves discovery under its base path —
`/api/auth/.well-known/openid-configuration` and
`/api/auth/.well-known/oauth-authorization-server` — already covered by the
existing `app.on(["POST","GET"], "/api/auth/*", …)` handler that builds
`createAuth` per request.

OAuth/OIDC clients fetch the **apex** path, so add two public alias routes,
registered **before** the auth/session middleware so they stay unauthenticated
and outside any future gate:

- `GET /.well-known/openid-configuration`
- `GET /.well-known/oauth-authorization-server`

Each returns the same metadata via the plugin's
`oauthProviderOpenIdConfigMetadata(auth)` / `oauthProviderAuthServerMetadata(auth)`
helpers. They must answer with permissive GET CORS
(`Access-Control-Allow-Origin: *`) since clients fetch them cross-origin; the
worker's existing global wildcard `cors()` already covers this for GET — confirm
these paths fall under it (they are not under `/api/auth/*`, which is owned by
the credentialed `authCorsMiddleware`).

Protected-resource metadata (`/.well-known/oauth-protected-resource`) is **not**
added here — it belongs to the resource servers (MCP + REST), sub-project 5.

### 4. Config / env plumbing

- **`validAudiences`:** a small helper `oauthValidAudiences(env)` returns the
  origin of `BETTER_AUTH_URL` plus the MCP origin. The MCP origin comes from a new
  optional var `OAUTH_RESOURCE_AUDIENCES` (comma-separated) in
  `workers/api/wrangler.jsonc` (prod + staging), defaulting to the known MCP host
  when unset. This is plain config, not a feature flag.
- **No new secret.** `jwt()` derives its keyset from `BETTER_AUTH_SECRET`, already
  bound via Secrets Store.
- `.env` / `.dev.vars` are **not** edited by this change. The spec lists what the
  operator must set; the user applies env changes.

### No feature flag

Per the approved decision, this ships **without** a Flagship flag. Rationale: the
AS is inert until a client exists, and the only way a client can exist in the
foundation is an explicit admin action (`adminCreateOAuthClient`) — there is no
public registration and no consent page, so a kill switch guards nothing a
not-yet-provisioned client wouldn't already prevent. Rollback is removing the two
plugins (and revoking any admin-created client). Sub-projects 4 (public
registration) and 5 (resource-server acceptance) reintroduce gating where it
actually changes exposure.

## Security considerations

- **Inert by default** — no client, no token; admin provisioning is the only entry
  point in this sub-project.
- **PKCE required** for public clients (plugin default); confidential clients use
  `client_secret`.
- **JWKS key material** is encrypted at rest under `BETTER_AUTH_SECRET`.
- **Audience pinning** (`validAudiences`) constrains where issued tokens are valid,
  setting up correct `aud` checks for the resource servers in sub-project 5.
- **Discovery endpoints are public** but expose only non-secret metadata.

## Testing / acceptance

- `npx tsc --noEmit` (root + `workers/api`), `bun test`, `bun run lint`,
  `bun run format:check` all green.
- A bun:sqlite unit test mirroring `workers/api/test/auth.test.ts`: `createAuth`
  constructs with the OAuth + JWT plugins, and the five new tables round-trip
  through the adapter.
- **Staging smoke:** `curl https://api-staging.releases.sh/.well-known/oauth-authorization-server`
  returns valid metadata (`authorization_endpoint`, `token_endpoint`, `jwks_uri`,
  `scopes_supported`, …); then an admin-created `skip_consent` client completes an
  `authorization_code` + PKCE exchange and the issued JWT verifies against
  `/api/auth/jwks` with the expected `iss`/`aud`/scopes.

## Risks & open items

- **CLI reconciliation:** the migration's column set must match
  `@better-auth/cli generate` output for `oauthProvider` + `jwt` at the pinned
  version; verify during implementation rather than trusting the doc-derived list.
- **Apex CORS:** confirm the two `.well-known` alias routes are reached by the
  global wildcard `cors()` and not shadowed by `authCorsMiddleware` (path-prefix
  check).
- **`disabledPaths`/`/token` collision:** the OAuth provider mounts `/oauth2/token`;
  confirm no existing `/api/auth` route collides (the docs note a `/token` path
  that can be disabled via `disabledPaths` if needed).
- **`@better-auth/oauth-provider` is new** (1.x); pin it exactly and re-run the
  full type-check, since plugin option/types churn faster than core.

## Decomposition

This foundation is sub-project 1 of 5. The remainder, each its own spec → plan →
implementation:

2. **Per-user entitlement model** — determine and enforce the scopes a user may
   consent to (read+identity for all; write/admin for curators/org-owners).
3. **Consent + authorization UI** — the `/oauth/consent` page + `oauthProviderClient`,
   showing only entitled scopes; reuses the existing sign-in page.
4. **Dynamic client registration + trusted first-party clients** — enable
   `allowDynamicClientRegistration` (+ `allowUnauthenticatedClientRegistration` for
   MCP clients), plus an admin route to mint trusted (`skip_consent`) clients.
5. **MCP + REST as resource servers** — verify OAuth JWTs (MCP worker via
   `jose`/JWKS, no `better-auth` import; API worker locally), map OAuth scopes onto
   the existing `McpIdentity`/`AuthContext` ladders coexisting with
   anonymous/`relk_`/`relu_`, and serve `.well-known/oauth-protected-resource` +
   `401 WWW-Authenticate`.
