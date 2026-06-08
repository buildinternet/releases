# OAuth provider sub-project 5: MCP + REST resource-server JWT verification (#1483)

## Goal

Make the REST API worker and the MCP worker _honor_ the JWT access tokens issued
by the "Sign in with Releases" AS (#1479), so a token minted through a Sign-in
flow actually grants `read`/`write`/`admin` on those surfaces — the final piece
of the OAuth roadmap.

## Token shape (from #1479/#1480)

- **Issuer**: `https://api.releases.sh` (the `BETTER_AUTH_URL` origin). JWKS at
  `https://api.releases.sh/api/auth/jwks` (better-auth `jwt()` plugin).
- **`aud`**: constrained to `oauthValidAudiences(env)` = the AS origin ∪
  `OAUTH_RESOURCE_AUDIENCES` (prod: `https://mcp.releases.sh`).
- **`scope`**: space-delimited OAuth scope string. Carries the identity scopes
  (`openid profile email offline_access`) plus the API ladder scopes
  (`read`/`write`/`admin`). Already clamped to the user's live role at issuance
  by `customAccessTokenClaims` (entitlement.ts) — the resource server trusts it.
- **`https://releases.sh/role`**: the user's role (informational here).

## Hard constraint

`workers/mcp` must stay free of `better-auth` (zod-pin reasons —
[[reference_mcp_worker_zod_pinned_to_sdk_nested]]). Verify with `jose` + the
JWKS endpoint, never by importing the AS.

## Design

### One shared verifier — `@releases/lib/oauth-jwt`

A worker-safe, better-auth-free module (depends only on `jose`, which is already
in the tree). Both workers import it the same way they already import
`@releases/lib/{secrets,flags,log-event}`.

- `isJwtShaped(raw)` — cheap routing check: three non-empty `.`-separated
  base64url-ish segments. The static root key and the `relk_`/`relu_` prefixes
  never match, so a presented credential routes to exactly one verifier.
- `extractApiScopes(payload)` — split the `scope` claim, intersect with the
  `read`/`write`/`admin` ladder. Identity scopes are dropped (not API authz).
- `verifyOAuthJwt(token, config)` — `jose.jwtVerify` against a cached
  `createRemoteJWKSet(jwksUrl)`, checking `iss`, `aud`, and `exp` (jose enforces
  expiry). Returns `{ subject, scopes, role, raw }` on success, `null` on any
  failure (bad sig / wrong iss|aud / expired / malformed). A `keyResolver`
  override makes it unit-testable with a `createLocalJWKSet` keypair — no network.

Remote key sets are memoized per `jwksUrl` (module-level map) so verification is
one JWKS fetch per cold start / rotation window, not per request.

### Config

- **API worker**: issuer + audience = `BETTER_AUTH_URL` origin (`api.releases.sh`).
  JWKS URL derived as `${issuer}/api/auth/jwks`. No new env.
- **MCP worker**: new optional vars `OAUTH_JWT_ISSUER` (default
  `https://api.releases.sh`) and `OAUTH_JWT_AUDIENCE` (default
  `https://mcp.releases.sh`); JWKS URL derived from the issuer. Staging overrides
  both. Verification is skipped (no JWT lane) when the issuer can't be resolved.

### Wiring — additive, fail-\* matches the existing lanes

- **REST** (`resolveAuthUncached`): a JWT-shaped credential that verifies →
  `{ kind: "token", tokenId: "oauth_<sub>", scopes }`. Verification failure →
  `{ kind: "none", skip: false }` — identical to an invalid `relk_`: rejected on
  a write/admin route (401), ignored on a public read (stays public).
- **MCP** (`resolveIdentity`): verifies → `{ kind: "token", scopes, token: null }`
  (scopes drive per-tool gating; downstream lookups fall back to the root key,
  same as the `relu_` lane). Failure → anonymous read. The staging gate is
  unchanged — a JWT identity carries `token: null`, so on mcp-staging it still
  needs the staging key (additive, never a mandatory gate — constraint from
  #1482).

The JWT is authoritative: scope comes from the verified `scope` claim, never
re-derived at the resource server.

## Out of scope / follow-ups

- Staging smoke of a full authorization_code + PKCE flow against a real client.
- `.well-known/oauth-protected-resource` advertisement (can come later; not
  required for token acceptance).
