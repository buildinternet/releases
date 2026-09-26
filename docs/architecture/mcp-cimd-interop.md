# Generic MCP client interop (CIMD + DCR + OAuth + sibling REST)

Playbook for this stack: one Better Auth OAuth 2.1 authorization server, Client ID Metadata Documents (CIMD) plus RFC 7591 dynamic client registration, RFC 8707 resource indicators, a hosted MCP resource server at `agents.releases.sh` (alias `mcp.releases.sh`), and a separate REST resource server (`api.releases.sh`) that some MCP tools call by forwarding the caller's access token.

The four failures below are the order a generic client (we used [MCPJam](https://www.mcpjam.com/)) hits them: ingest, authorize `scope=`, authorize `resource=`, then a tool that HTTP-fetches the sibling API. All four apply here. `serverInfo.icons` is a fifth, cosmetic miss.

This worker is better-auth 1.7. Generic clients get a `client_id` one of two ways: CIMD (the client sends an HTTPS URL as its `client_id`; see [§0](#0-cimd-url-client-ids)) or DCR (`POST /oauth2/register`). Sections 1 and 1a are DCR ingest fixes; sections 2 onward apply to both lanes. Source for the pattern: [sunny/docs/mcp-cimd-interop.md](https://github.com/buildinternet/sunny/blob/main/docs/mcp-cimd-interop.md) and the sibling [uploads PR](https://github.com/buildinternet/uploads/pull/851). Read this before changing discovery, implementing a grant this AS does not issue, or expanding DCR default scopes.

## 0. CIMD: URL client IDs

**What it is.** With [Client ID Metadata Documents](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-02), a client sends an HTTPS URL as `client_id` on `/oauth2/authorize`. The AS fetches the JSON document at that URL and treats it as the client's registration. Nothing is registered ahead of time. Claude's "Use Claude's published identity (CIMD)" connector option works this way; its document is `https://claude.ai/oauth/mcp-oauth-client-metadata`. The MCP authorization spec deprecates DCR in favor of CIMD, so CIMD is the recommended option in Claude's connector dialog.

**What we do.** `cimd()` from `@better-auth/cimd` sits next to `oauthProvider()` in `apps/api/src/auth/instance.ts`, with `metadataProfile: "mcp-2026-07-28"` (requires `client_name` and `redirect_uris`). It adds `client_id_metadata_document_supported: true` to AS metadata. On the first authorize for a URL, the plugin fetches the document, validates it, and persists an `oauth_client` row whose `client_id` is the URL and whose `client_discovery_id` is `cimd`. It revalidates the document at most hourly, honoring the document's cache headers. DCR stays on for clients that don't send a URL.

**Policy (same ceiling as DCR).** The plugin enforces most of it:

- Stored scopes come from `clientRegistrationDefaultScopes` (`DCR_SCOPES`: identity + `read`). A document that declares a wider `scope` is **refused**, not capped. That's stricter than DCR, which caps. No published MCP client document we've checked (Claude, VS Code, MCPJam) sets `scope`.
- A document carrying server-owned fields (`skip_consent`, `require_pkce`, `client_secret`, `disabled`, …) is refused.
- `token_endpoint_auth_method` must be `none` or `private_key_jwt`; shared-secret methods are refused. PKCE stays required.
- `grant_types` needs one mutually supported grant; extras are tolerated. claude.ai lists `jwt-bearer` and VS Code lists `device_code`, and both register. The advertised list is stored as-is; the token endpoint rejects any grant this AS doesn't issue. This is the §1 rule, applied natively.
- A document with no `application_type` validates its redirect URIs as native, so loopback and private-use schemes work without the §1a rewrite.
- `client_uri` must share the `client_id` origin, so the host on the consent page is verified.

`cimdClientRowPatch` (`apps/api/src/auth/oauth-cimd.ts`) re-applies the ceiling once, when a row is created, mirroring `clampRegisteredDcrClient`. Refreshes are left alone: the plugin re-derives scopes and keeps operator flags, so an admin `trusted` PATCH on a CIMD client survives.

**Fetch transport (SSRF).** The plugin takes the transport as a required option. `createWorkersClientMetadataFetch` is ours. The plugin already requires HTTPS, rejects IP-literal and localhost hosts that aren't public-routable, caps the body at 5 KB and the fetch at 5 s, and rate-limits fetches per client, per origin, and globally (in memory, per isolate). The transport:

- Sends `redirect: "manual"` and throws on any 3xx except 304. The plugin asks for `redirect: "error"`, which workerd's `fetch` rejects. 304 passes through because the plugin sends conditional requests.
- Allows only GET and HEAD over HTTPS.
- Re-runs the plugin's `validateClientIdUrl` host check on every fetch, so the plugin's follow-up fetches (a document's `jwks_uri`) get it too.

The plugin's Node transport also resolves DNS once and pins the connection, so a public hostname can't rebind to a private address. We rely on the platform for that on Workers: Cloudflare won't connect a Worker subrequest to a private or reserved address.

**Reaper.** CIMD rows are `oauth_client` rows. The nightly sweep (`cron/sweep-oauth-clients.ts`) reaps them like abandoned DCR rows. That's harmless: the next authorize recreates the row from the document.

**Compared with uploads.** buildinternet/uploads (`apps/auth/src/cimd-transport.ts`) rewrites each fetched document with its DCR sanitizer, so a document asking for more is capped rather than refused, and a `private_key_jwt` client becomes public. We deliberately refuse instead: every published document we've checked passes unchanged, and refusing never downgrades a client's authentication.

**Do not.** Pass the plugin's Node transport (`@better-auth/cimd/node`) on Workers; it needs `node:dns` and `node:https`. Add a `scope` rewrite to accept documents that ask for `write`/`admin`. Clamp on refresh. Turn DCR off while clients without CIMD support remain.

## 1. `invalid_client_metadata` / unsupported `grant_type` `device_code`

**Error (AS, DCR `POST /oauth2/register`):** oauth-provider's register schema is a closed enum (`authorization_code` | `refresh_token` | `client_credentials`). A body that lists `urn:ietf:params:oauth:grant-type:device_code` fails the parse.

**Why a generic client does it.** CIMD/DCR `grant_types` is a capability advertisement. MCPJam's document lists `authorization_code`, `refresh_token`, and `urn:ietf:params:oauth:grant-type:device_code` because its CLI can run the device flow. The authorize URL it actually sends is a normal `response_type=code` + PKCE request. Same class: claude.ai adds `urn:ietf:params:oauth:grant-type:jwt-bearer`.

**Rule.** Intersect advertised grants with the grants this AS issues. Ignore extras at ingest. Enforce at the token endpoint (`unsupported_grant_type`) if someone actually requests a grant you do not implement. Do not treat DCR `grant_types` as a demand that you implement every listed grant.

**What we do.** `rewriteClientMetadataGrantTypes` in `apps/api/src/auth/oauth-grant-types.ts`, applied by `applyOAuthClientInterop` on `/oauth2/register` so `grant_types` is the intersection with `authorization_code`, `refresh_token`, and `client_credentials` before the plugin parses it. Leave the body untouched if `authorization_code` would not remain: ingest still rejects a device-code-only client.

This worker does implement RFC 8628 for the seeded `releases-cli` client (`deviceAuthorization()` in `apps/api/src/auth/instance.ts`). oauth-provider's DCR ingest validator does not treat that plugin's grant as supported, so `device_code` stays out of the intersection list.

**Do not.** Add `device_code` or `jwt-bearer` to the DCR supported-grant list without shipping that grant through oauth-provider. Do not implement RFC 8628 for DCR clients just so the metadata document parses.

## 1a. `invalid_client_metadata` on `application_type` (opencode, Cursor)

**Error (AS, DCR `POST /oauth2/register`):** `@better-auth/oauth-provider` 1.7 classifies a registration body that omits `application_type` as `"web"` (better-auth/better-auth#10913), then rejects loopback-http and private-use-scheme redirect URIs for a `"web"` client (better-auth/better-auth#10946) — even though RFC 8252 §7 requires exactly those URI shapes for a native client.

**Why a generic client does it.** opencode registers a bare RFC 7591 body: a loopback `http://127.0.0.1:<port>/…` redirect URI and no `application_type` at all. Cursor registers an explicit `application_type: "web"` alongside a mixed redirect-URI set — a private-use-scheme `cursor://anysphere.cursor-mcp/oauth/callback` plus an `https://…` URI (see [forum.cursor.com/t/…/136907](https://forum.cursor.com/t/cursor-does-not-send-application-type-native-when-registering-mcp-oauth-clients/136907)). Neither client shape declares `application_type: "native"` even though both need native-client redirect-URI handling, and MCP's 2026-07-28 spec update requires native clients to send that field.

**Rule.** Default a registration body with no `application_type` to `"native"` when its `redirect_uris` are consistent with a native client (loopback-http / private-use-scheme, or a private-use scheme mixed with valid-native https). Coerce an explicit `application_type: "web"` to `"native"` only when the client mixes in a private-use-scheme redirect URI and every URI is a valid-native shape — leave a `"web"` client with loopback-http-only or pure-https redirects untouched, and never touch an already-`"native"` body.

**What we do.** `defaultRegistrationApplicationType` and `coerceExplicitWebToNativeForPrivateUseScheme` in `apps/api/src/auth/oauth-application-type.ts`, applied by `applyOAuthClientInterop` on `/oauth2/register` alongside the `grant_types` rewrite (composed on the same body).

**This stack is `@better-auth/oauth-provider@1.7.2`, so this rewrite is live** — it was written under the 1.6.25 pin as forward-compat and became load-bearing with the 1.7 upgrade. Ported from buildinternet/uploads PRs #885–#887.

**The 1.7 native validator needs a dist patch.** Routing Cursor to the native branch exposes a second upstream bug: 1.7 accepts only authority-free reverse-domain private-use redirect URIs and rejects the host-bearing `cursor://anysphere.cursor-mcp/oauth/callback` form (better-auth/better-auth#10956, #10946 — still unfixed in 1.7.2). Uploads PR #886's dist patch is therefore ported as `patches/@better-auth%2Foauth-provider@1.7.2.patch`, wired through bun `patchedDependencies` in the root `package.json`. Delete it once an upstream release ships the fix; re-check on every `@better-auth/oauth-provider` bump, since the patch targets a hashed dist filename.

**Do not.** Carry the dist patch forward blindly across an upgrade — check whether #10956/#10946 shipped first. Widen the native-defaulting rule to plain `https://` redirect URIs (that is a legitimate web-client shape). Treat this section as live behavior on the current stack — verify against the pinned `@better-auth/oauth-provider` version before assuming otherwise.

## 2. `invalid_scope` on authorize or consent

**Error (AS, `/oauth2/authorize` or `/oauth2/consent`):**

```
invalid_scope: The following scopes are invalid: extra, admin
```

**Why a generic client does it.** RFC 9728 / AS metadata `scopes_supported` is the product's full list (`read`, `write`, `admin`, plus identity scopes on the AS). Generic clients copy that list into authorize `scope=` and often add extras (`openid` is already in our list; unknown ids are not). Better Auth then rejects the entire authorize when the request is a superset of the registered list. A non-admin user who later consents to a kitchen-sink that still includes `admin` hits the entitlement gate (`consentScopeViolation`).

**Rule.** [RFC 6749 §3.3](https://datatracker.ietf.org/doc/html/rfc6749#section-3.3): the AS MAY ignore requested scopes it cannot or will not grant. Downscope to the client's registered list and drop unknown ids. At consent (and on the authorization-code blob), also intersect with the signed-in user's `entitledScopes`. Fail only when nothing usable remains. Keep `admin` requestable at authorize only when the **client** is registered for it (admin-provisioned first-party clients). Open DCR and CIMD clients are stored with `DCR_SCOPES` (identity + `read`) and cannot step up.

**What we do.** `apps/api/src/auth/oauth-grant-scopes.ts` intersects `scope=` with `oauth_client.scopes` (fallback: `DCR_SCOPES`, not the advertised AS list) on authorize, consent, and the authorization-code blob. Consent and the code blob also strip scopes the user's role cannot hold. Discovery still lists `admin` in `scopes_supported`. DCR registration is additionally capped by `clientRegistrationDefaultScopes` / `clientRegistrationAllowedScopes` plus `sanitizeDcrRegistrationBody` (public/PKCE, no `skip_consent`, no `client_credentials`). On a CIMD client's first authorize the row doesn't exist yet when the rewrite runs (the plugin creates it later in the same request), so the `DCR_SCOPES` fallback applies — the same set the row is then stored with.

**Do not.** Expand DCR default scopes to whatever a client puts in `scope=` or to the discovery `scopes_supported` list. Do not fail the whole authorize when a usable subset remains. Do not grant `admin` or `write` because the client copied them from discovery.

### 2a. `offline_access`: no refresh token without it

**Symptom.** The client gets a 1h access token and no `refresh_token`, so the user is bounced through interactive re-auth at expiry. `@better-auth/oauth-provider` issues a refresh token only when the grant's scopes carry `offline_access`; MCP clients build `scope=` from the protected-resource metadata (`apps/mcp/src/well-known.ts`), which advertises the API ladder (`read write admin`) and no identity scopes, so they never ask for it.

**What we do.** `offline_access` is an `IDENTITY_SCOPE` (`apps/api/src/auth/entitlement.ts`), so it is in the provider `scopes` list — which is also the DCR registration default — and every role is entitled to it. `oauth-grant-scopes.ts` then _unions_ it into the rewritten scope on authorize, consent, and the code blob for any client registered with it. Existing `oauth_client` rows were backfilled by `apps/api/migrations/20260831130000_oauth_client_offline_access.sql`. Ported from [uploads#913](https://github.com/buildinternet/uploads/pull/913).

**Do not.** Let an `offline_access`-only request through: with no real scope alongside it the rewrite clears the list so the plugin's `invalid_scope` fires, rather than minting a refresh-token-only grant. Note the plugin also requires PKCE (or an OIDC nonce) once `offline_access` is in the request — a non-issue here, since our clients are PKCE clients and the plugin defaults `requirePKCE` to true even for confidential ones.

## 3. `invalid_target` / requested resource not configured

**Error (AS, authorize):**

```
invalid_target: requested resource https://mcp.releases.sh/mcp is not configured
```

**Why a generic client does it.** RFC 9728 protected-resource metadata on this worker advertises `resource` as the origin (`https://mcp.releases.sh`). Some clients copy that string into authorize `resource=` (RFC 8707). Others copy the transport URL (`https://agents.releases.sh/mcp` today, or the still-working `https://mcp.releases.sh/mcp` alias — both are what `server.json` remotes and `npx mcp-remote` have used). The AS had only listed the origin (plus a trailing-slash variant).

**Rule.** Accept both the origin and the `/mcp` form for every MCP identifier the AS is willing to mint. The MCP resource server must accept both as JWT `aud`. Discovery can keep advertising the origin. Clients that pass `resource=origin` must keep working, and so must clients that pass `origin/mcp`.

**What we do.** `mcpResourceAndOrigin` in `@releases/lib/oauth-jwt`: `oauthValidAudiences` expands every `OAUTH_RESOURCE_AUDIENCES` entry both ways. MCP JWT verification (`apps/mcp/src/auth.ts`) lists the same pair. RFC 9728 on the MCP worker still advertises the origin.

**Do not.** Change discovery to `/mcp` only. Do not drop the origin form. Do not accept arbitrary `resource=` values. Do not expand the API origin (`BETTER_AUTH_URL`) with `/mcp`.

## 4. REST 401 when an MCP tool forwards the Bearer

**Error (sibling API, after a successful MCP call that HTTP-fetches it):** a follows tool (`follow` / `unfollow` / `list_follows` / `get_personalized_feed`) forwards the caller's OAuth JWT to `/v1/me/*` over the `API` service binding. `jwtVerify` failed on `aud`. The token was minted for the MCP resource.

**Why a generic client does it.** The token is minted for the MCP resource (`aud` = `mcp.releases.sh` or `…/mcp`). Follows tools must act as that user against the API; they cannot invent a second credential. The API's accepted audiences were only the API origin.

**Rule.** Same-environment MCP origin and `/mcp` must be accepted audiences on every API gate that already verifies Bearer JWTs. Derive them from `OAUTH_RESOURCE_AUDIENCES` the same way the AS does: staging API never accepts prod MCP `aud`, and vice versa. Keep issuer + API resource ids.

**What we do.** `oauthJwtConfig` in `apps/api/src/middleware/auth.ts` unions the API origin with `mcpResourceAndOrigin` of every `OAUTH_RESOURCE_AUDIENCES` entry. Follows tools still forward `userToken`. On-demand lookup still does not: that path uses `token: null` and falls back to the root key.

**Do not.** Stop forwarding and invent a second auth path for `/v1/me/*`. Do not accept arbitrary audiences. Do not let a staging MCP token verify on prod.

## Hosted `/mcp` credentials

Hosted `/mcp` accepts an OAuth JWT, a `relk_` machine token, a `relu_` user key, or no credential (anonymous read). An API session cookie will not authenticate there.

`serverInfo.icons` points at `https://releases.sh/icon.svg` (`apps/mcp/src/mcp-agent.ts`). Inspector Overview tabs read that field; omitting it shows an empty icon.
