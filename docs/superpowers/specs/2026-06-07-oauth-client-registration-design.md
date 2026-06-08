# RAL-1482 — OAuth client registration + trusted clients

**Issue:** [#1482](https://github.com/buildinternet/releases/issues/1482) — sub-project **4 of 5** of the "Sign in with Releases" OAuth AS.

Builds on #1479 (AS foundation), #1480 (per-user scope entitlement + consent UI),
and #1484 (role provisioning). Prereq for #1483 (MCP + REST resource-server JWT
verification).

## Problem

The authorization server is live but **inert**: a human `authorization_code` +
PKCE flow can complete with per-user scope entitlement, but there is **no
supported way to provision an OAuth client**. Dynamic client registration is OFF
(`allowDynamicClientRegistration: false`) and there is no admin provisioning
surface, so the AS cannot be used end-to-end in production. Today the only way to
get a client into the `oauth_client` table is a hand-written D1 row — which must
reproduce the plugin's secret hashing, ID generation, and JSON encoding by hand,
and is therefore error-prone.

Separately, `@better-auth/oauth-provider` auto-mounts **session-gated,
HTTP-exposed** self-service client endpoints (`/api/auth/oauth2/create-client`,
`/oauth2/update-client`, `/oauth2/client/rotate-secret`, `/oauth2/delete-client`).
These have been reachable by any logged-in user since #1479. They are
owner-scoped, cannot set `skip_consent`, and issued-token scope is still capped
by the user's role — but they are an open client-registration surface, which is
not fail-closed for a first-party-only AS.

## Decisions (resolved with the user)

1. **Admin-only provisioning. Dynamic client registration stays OFF.** Keep
   `allowDynamicClientRegistration: false`. Add a root-key-gated admin route as
   the canonical (and only sanctioned) provisioning path. RFC 7591 dynamic
   registration remains a clean single-flag future flip if/when third-party
   clients become a real need, with guardrails designed at that time.
2. **Surface = REST route (this repo) + CLI verbs (follow-up).** Build the
   root-key-gated REST routes in `workers/api` here; add
   `releases admin oauth client create/list/rotate/disable/delete` verbs in the
   `releases-cli` repo in a separate PR (mirroring #288).
3. **Lock down the plugin's self-service write endpoints to admin-only.** A Hono
   pre-filter blocks `/api/auth/oauth2/{create,update,delete}-client` and
   `/oauth2/client/rotate-secret` for sessions whose user role is not `admin`.
   The public/read endpoints (`public-client`, `public-client-prelogin`,
   `get-client`, `get-clients`) are left untouched — the #1480 consent screen
   reads `public-client(-prelogin)`.
4. **Trusted clients = `skip_consent`, settable only via the admin path.** Only
   the SERVER_ONLY admin endpoint reachable behind the root key can set
   `skip_consent`. The #1480 entitlement backstop already covers `skip_consent`
   clients, so this is safe.

## Verified facts about `@better-auth/oauth-provider@1.6.14`

- **Secret storage is one-way hashed by default** (`storeClientSecret` defaults to
  `"hashed"` when the `jwt()` plugin is present): `defaultHasher` =
  `base64Url(SHA-256(secret), { padding: false })`, no salt. Secrets are
  show-once and unrecoverable.
- **SERVER_ONLY admin endpoints exist** and are callable only via `auth.api.*`
  (rejected over direct HTTP): `auth.api.adminCreateOAuthClient`
  (`/admin/oauth2/create-client`) and `auth.api.adminUpdateOAuthClient`
  (`/admin/oauth2/update-client`). `adminCreate` generates the clientId, hashes
  the secret, maps snake*case input, JSON-encodes `redirect_uris`, and returns
  the \*\*`reloc*`-prefixed\*\* secret once.
- **`adminUpdateOAuthClient` does NOT accept `disabled`.** Its update object
  covers `redirect_uris`, `scope`, `skip_consent`, `enable_end_session`,
  `metadata`, etc., but not the `disabled` column. Disable/enable must be a direct
  Drizzle column write.
- **There is no SERVER_ONLY admin rotate or delete** — only the session-gated,
  owner-scoped user endpoints. Admin-created clients have a **null `userId`**
  (no session in a SERVER_ONLY call), so those owner-scoped endpoints can't even
  find them. Admin rotate/delete must be implemented directly.
- **`disabled` is enforced everywhere (fail-closed kill switch):** rejected at
  authorize (`client_disabled` redirect), token (`400`), introspect
  (`active:false`), and client-credentials validation.

## Architecture

A new root-key-gated namespace `admin/oauth` in the API worker, structured
exactly like #1484's `admin-users.ts`: gated by `authMiddleware` via a
`route-namespaces.ts` entry, each mutation emits an audited `logEvent`
(`actor: "root-key"`), fail-closed input handling, and **no OpenAPI annotations
required** (admin namespaces are exempt from the coverage gate, same as
`admin/users`).

It delegates to the plugin where secret-hashing/format correctness matters, and
uses thin Drizzle ops where it does not. The split is deliberate: never
reimplement secret hashing or clientId generation; do reimplement trivial column
toggles.

### Operations

| Operation            | Route                                                  | Mechanism                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Create**           | `POST /v1/admin/oauth/clients`                         | `auth.api.adminCreateOAuthClient` (SERVER*ONLY). Passes through `redirect_uris`, `scope`, `client_name`, `client_uri`, `logo_uri`, **`type`**, **`token_endpoint_auth_method`**, `grant_types`, `require_pkce`, and `skip_consent` (from `--trusted`). Returns the `reloc*`-prefixed secret **once** (or none for a public client). |
| **List**             | `GET /v1/admin/oauth/clients`                          | Drizzle select of **public fields only**.                                                                                                                                                                                                                                                                                           |
| **Get**              | `GET /v1/admin/oauth/clients/:clientId`                | Drizzle select one; public fields only.                                                                                                                                                                                                                                                                                             |
| **Disable / Enable** | `PATCH /v1/admin/oauth/clients/:clientId { disabled }` | Drizzle update of `disabled`. May also toggle `skip_consent` via `auth.api.adminUpdateOAuthClient`.                                                                                                                                                                                                                                 |
| **Rotate secret**    | `POST /v1/admin/oauth/clients/:clientId/rotate-secret` | Generate with the plugin's own primitives (`generateRandomString` from `better-auth/crypto`, `base64Url(SHA-256(secret))` from `@better-auth/utils`) → zero format drift. Store the **unprefixed hash**; return `reloc_`+secret once. 404 / `400 public_client_no_secret` for a public (secretless) client.                         |
| **Delete**           | `DELETE /v1/admin/oauth/clients/:clientId`             | Drizzle delete.                                                                                                                                                                                                                                                                                                                     |

**Public-fields projection (never the secret):** `clientId`, `name`,
`redirectUris`, `scopes`, `trusted` (= `skipConsent`), `disabled`, `type`,
`tokenEndpointAuthMethod`, `public`, `createdAt`, `updatedAt`. The stored
`clientSecret` is a one-way hash and is never returned by any read path.

### Self-service lockdown

A Hono middleware mounted **before** the `/api/auth/*` forward inspects method +
path. For the four write self-service endpoints it resolves the caller's session
(`auth.api.getSession` with the request headers) and returns
`403 oauth_self_service_admin_only` unless `session.user.role === "admin"`. The
read/public endpoints are not intercepted (consent depends on them). This makes
the root-key admin route the only client-provisioning path for non-admins while
leaving an admin a browser fallback.

## Fail-closed posture

- Unprovisioned client → no row → cannot authorize. Disabled client → rejected at
  every issuance path (verified above). `allowDynamicClientRegistration` stays
  `false`.
- The #1480 entitlement ceiling applies **regardless of client trust**: a
  trusted/`skip_consent` client still cannot get a user a scope beyond their
  role, because `customAccessTokenClaims` re-checks entitlement at every token
  issuance (incl. refresh + skip_consent).
- `--trusted` (`skip_consent`) is structurally admin-only — only the SERVER_ONLY
  endpoint behind the root key can set it; the self-service lockdown removes the
  user path entirely.

## MCP compatibility

A near-/mid-term consumer of this is the **MCP client**, and a hard requirement is
that **MCP continues to work unauthenticated**. This design is compatible:

- **#1482 does not touch the MCP worker or any MCP request path.** It adds an
  API-worker admin route plus an `/api/auth/*` self-service pre-filter. The MCP
  worker is never imported into or modified by this work and stays free of
  `better-auth` (the #1483 constraint). The unauthenticated MCP path is
  unaffected.
- **An MCP OAuth client is provisionable as a public/PKCE client.** MCP hosts
  cannot hold a client secret, so the eventual MCP client is a _public_ client
  (`type: native`/`user-agent-based`, `token_endpoint_auth_method: "none"`,
  `require_pkce: true`). Because the create route passes `type` /
  `token_endpoint_auth_method` through to `adminCreateOAuthClient`, a secretless
  public client is provisionable on day one. (The plugin emits no secret for
  public clients.)
- **DCR remains a clean future flip.** If the future MCP auth flow follows the
  MCP spec's RFC 7591 per-host dynamic registration, that is a single
  `allowDynamicClientRegistration` change later, not a redesign.

**Constraint carried to #1483 (resource-server JWT verification):** MCP OAuth must
be **additive** — an opt-in capability layer, never a mandatory gate — so the
unauthenticated path survives. #1482 is fully compatible with that rule.

## Testing

Integration tests in `workers/api`:

- Create returns a `reloc_`-prefixed secret and persists a hashed (not plaintext)
  secret; the returned secret verifies via the plugin's `verifyStoredClientSecret`.
- Create with `type: native` / `token_endpoint_auth_method: "none"` yields a
  public client with **no** secret.
- List / Get never include the secret.
- Disable flips the `disabled` column and a subsequent token exchange is rejected.
- Rotate changes the stored hash; the previous secret no longer verifies; the new
  one does.
- Delete removes the row.
- The self-service pre-filter returns `403` for a non-admin session on
  `create-client` and passes an admin session; `public-client-prelogin` is never
  intercepted.

## Scope / non-goals

- **No migration, no new tables** — `oauth_client` already has every column
  (`clientSecret`, `disabled`, `skipConsent`, `public`, `type`,
  `tokenEndpointAuthMethod`, `redirectUris`, `scopes`, …).
- **No CLI in this PR** — follow-up in `releases-cli`.
- **No RFC 7591 dynamic registration** — stays off.
- **Docs:** record `admin/oauth` as the second sanctioned exception to the
  "no new `/v1/admin/*` CRUD" rule in `docs/architecture/remote-mode.md`
  (alongside role provisioning).
