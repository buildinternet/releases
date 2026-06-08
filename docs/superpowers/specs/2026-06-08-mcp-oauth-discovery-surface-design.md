# MCP OAuth discovery surface (RFC 9728 protected-resource metadata + invalid-token challenge)

Follow-up to the "Sign in with Releases" OAuth roadmap (#1479→#1483). The resource-server
JWT lane (#1483/#1487, issuer fix #1490) is wired correctly and the audience config is
internally consistent end-to-end (canonical MCP URI = resource-server `aud` = AS
allowed-audience = `https://mcp.releases.sh`). But it is **non-functional for any
off-the-shelf MCP client**, because the MCP worker is missing the discovery surface the
MCP authorization spec (revision 2025-06-18) mandates.

## Problem

Per MCP auth spec 2025-06-18, a standards-compliant MCP client only sends the RFC 8707
`resource` parameter (which is what makes the better-auth AS mint a JWT instead of an
opaque token) **after** discovering the canonical resource URI and its authorization
server via:

1. A `401` + `WWW-Authenticate: Bearer resource_metadata="…"` challenge from the MCP
   server (RFC 9728 §5.1), and
2. `GET /.well-known/oauth-protected-resource` (RFC 9728) advertising `resource` +
   `authorization_servers`.

The MCP worker (`workers/mcp/src/index.ts`) serves **neither**: there is no `.well-known`
route, and the unauthenticated path falls through to **anonymous read** (it never returns
a 401). So a vanilla client never learns it should authenticate, nor what `resource` to
send — the JWT lane only works in a hand-driven flow (the staging smoke).

This is verified against (a) the live MCP spec, (b) better-auth `oauth-provider` 1.6.14
source (`createUserTokens` → `isJwtAccessToken = audience && !disableJwtPlugin`, audience
from `checkResource(ctx.body.resource)` validated against `validAudiences`), and (c) live
prod: `GET https://mcp.releases.sh/.well-known/oauth-protected-resource` → 404.

## Goal

Make the existing JWT lane reachable by standards-compliant MCP clients by adding the
RFC 9728 discovery the spec requires — **without breaking anonymous read** (a deliberate
product feature: the MCP server is a public changelog registry).

## Non-goals

- Connect-time 401 / full-protected-server model — rejected, breaks public read.
- REST API worker protected-resource metadata — the REST API is an OAuth resource server
  too, but is not an MCP server; not the motivating case. Follow-up.
- Staging JWKS-behind-the-access-gate (the resource server's `createRemoteJWKSet` fetch to
  `api-staging` JWKS can't clear the staging gate). Independent known limitation.
- The AS self-origin-resource `500`-instead-of-`400` robustness bug. Independent.
- Dynamic client registration (stays off) and provisioning a first prod client.

## Design

### 1. Protected-resource metadata document (RFC 9728)

A pure, unit-testable builder + a public route.

- **`buildProtectedResourceMetadata(env)`** — new module
  `workers/mcp/src/well-known.ts`. Derives the document entirely from the existing env
  vars so staging is automatically correct (no new config):

  ```jsonc
  {
    "resource": env.OAUTH_JWT_AUDIENCE,                 // prod: https://mcp.releases.sh
    "authorization_servers": [env.OAUTH_JWT_ISSUER],    // prod: https://api.releases.sh/api/auth
    "scopes_supported": ["read", "write", "admin"],
    "bearer_methods_supported": ["header"]
  }
  ```

  When the vars are unset (local dev), fall back to the same prod defaults the auth path
  already hard-codes (`DEFAULT_OAUTH_AUDIENCE` / `DEFAULT_OAUTH_ISSUER`) so the two
  surfaces never disagree. Export those defaults from `well-known.ts` or share them from
  `auth.ts` — single source of truth.

  `resource` deliberately equals the configured `aud` (the bare origin
  `https://mcp.releases.sh`, an explicitly-valid canonical URI per the spec examples and
  already an allowed audience in the AS `OAUTH_RESOURCE_AUDIENCES`). So a compliant
  client's `resource` round-trips: AS `checkResource` accepts it, mints a JWT with that
  `aud`, and the resource server's jose `aud` check matches.

- **Route** — in `workers/mcp/src/index.ts`. In prod (no `STAGING_ACCESS_KEY`) it is
  served **before** `resolveMcpAuth` (same position as the existing `/robots.txt`
  short-circuit) so it is public discovery, like the AS's public JWKS. On staging it is
  deferred until **after** the staging access gate so it stays opaque like every other
  route (a harness already carries the staging key; this matches the AS JWKS, which is
  also gated on staging):
  - `GET /.well-known/oauth-protected-resource`
  - `GET /.well-known/oauth-protected-resource/mcp` (RFC 9728 §3.1 path-insertion — some
    clients derive the well-known from the `/mcp` transport path)
  - Both return the same document, `Content-Type: application/json`, a short
    `Cache-Control: public, max-age=3600`. The `X-Robots-Tag` wrapper in the outer
    `fetch` continues to apply when indexing is disabled.

### 2. WWW-Authenticate challenge on an invalid OAuth token

In `workers/mcp/src/auth.ts`, distinguish **no credential** (→ anonymous read, unchanged)
from **a presented OAuth JWT that fails verification** (→ `401` + `WWW-Authenticate`).

- Scope the change to the **OAuth JWT lane only.** A JWT-shaped bearer that fails
  `verifyOAuthJwt` (or verifies with zero API scopes) → the auth result becomes a 401
  carrying:
  ```text
  WWW-Authenticate: Bearer error="invalid_token", resource_metadata="<absolute metadata URL>"
  ```
  The `resource_metadata` URL is built from the request origin +
  `/.well-known/oauth-protected-resource` so it is correct on prod, staging, and local.
- **Unchanged:** the `relk_`/`relu_` machine/user-key lanes keep their current
  fall-open-to-anonymous behavior (a machine-token holder will not run an OAuth dance;
  changing their semantics is unrelated scope). No-token requests stay anonymous.
  Feature-flag-off cases (`user-api-keys-enabled` off, `api-tokens-disabled`) stay
  anonymous — they are not "invalid credentials."
- **Mechanism:** `resolveIdentity` currently returns `ANONYMOUS` on a failed JWT verify.
  Introduce a distinct "JWT presented but invalid" outcome that `resolveMcpAuth` turns
  into a 401 response (mirroring the existing `{ ok: false, response }` shape used for the
  rate-limited and staging-gate cases). The challenge response is built by a small helper
  so the header format lives in one place.
- **Staging interaction:** the global staging-gate 401 still runs first on staging; OAuth
  there remains harness-only (unchanged).

## Data flow (compliant client, prod)

1. Client is pointed at `https://mcp.releases.sh/mcp` and is told (or probes) that it can
   authenticate — or it presents a stale/expired JWT.
2. On an invalid JWT → `401` + `WWW-Authenticate` with `resource_metadata`.
3. Client fetches `/.well-known/oauth-protected-resource` → `{ resource, authorization_servers }`.
4. Client does RFC 8414 AS-metadata discovery from
   `https://api.releases.sh/api/auth` (resolves to the live `…/.well-known/oauth-authorization-server`).
5. Client runs the OAuth 2.1 + PKCE flow, sending `resource=https://mcp.releases.sh` on
   authorize **and** token → AS mints an RS256 JWT with `aud=https://mcp.releases.sh`.
6. Client retries with `Authorization: Bearer <jwt>` → resource server verifies and honors
   the scopes. Anonymous read is unaffected throughout.

## Error handling

- Metadata route: pure read, no failure modes beyond env-var fallback to prod defaults.
- Invalid JWT → 401 + challenge (new). No-token / valid-token / machine-lane paths
  unchanged. `verifyOAuthJwt` never throws (returns null), so the 401 decision is a simple
  null check.

## Testing (TDD)

- `buildProtectedResourceMetadata`: env→doc, including the unset-var → prod-default
  fallback, and `resource` == configured `aud`.
- Auth path:
  - no `Authorization` header → anonymous, **no** `WWW-Authenticate`.
  - invalid JWT (verify fails via the local-keyset test seam, or a JWT-shaped string with
    no matching key) → `401` with the exact `WWW-Authenticate` header + `resource_metadata`.
  - valid JWT → unchanged identity, no challenge.
  - invalid `relk_` → still anonymous (regression guard for the deliberately-unchanged lane).
  - staging gate precedes the challenge: an invalid JWT with the gate bound but no staging
    key → generic `401` (no `WWW-Authenticate`); with the staging key → the challenge.
- Metadata builder / path matcher / response builder / challenge string are unit-tested
  directly. The `index.ts` route wiring is not unit-tested (its `agents/mcp` import is
  unresolvable under root `bun test`, same as the rest of `index.ts`); it mirrors the
  `/robots.txt` short-circuit and is covered by deployed-surface checks post-merge.
- `bun test` green; `tsc --noEmit` clean on root + `workers/mcp` (zod-pin intact — no new
  deps).

## Files

- `workers/mcp/src/well-known.ts` — NEW: `buildProtectedResourceMetadata`, the metadata
  type, the WWW-Authenticate challenge-header builder, shared default issuer/audience.
- `workers/mcp/src/index.ts` — add the two well-known GET routes: public pre-auth in prod,
  deferred past the staging gate when `STAGING_ACCESS_KEY` is bound.
- `workers/mcp/src/auth.ts` — distinguish invalid-OAuth-JWT from anonymous; emit the 401
  challenge from `resolveMcpAuth`.
- `workers/mcp/test/*` — unit + auth tests above.
- `docs/architecture/mcp.md` — document the discovery surface + the deliberate
  anonymous-read / invalid-token-challenge stance.
