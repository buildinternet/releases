# Generic MCP client interop (DCR + OAuth + sibling REST)

Playbook for this stack: one Better Auth OAuth 2.1 authorization server, RFC 7591 dynamic client registration, RFC 8707 resource indicators, a hosted MCP resource server at `mcp.releases.sh`, and a separate REST resource server (`api.releases.sh`) that some MCP tools call by forwarding the caller's access token.

The four failures below are the order a generic client (we used [MCPJam](https://www.mcpjam.com/)) hits them: ingest, authorize `scope=`, authorize `resource=`, then a tool that HTTP-fetches the sibling API. All four apply here. `serverInfo.icons` is a fifth, cosmetic miss.

This worker is better-auth 1.6. There is no `@better-auth/cimd` plugin; generic clients register via DCR (`POST /oauth2/register`). Source for the pattern: [sunny/docs/mcp-cimd-interop.md](https://github.com/buildinternet/sunny/blob/main/docs/mcp-cimd-interop.md) and the sibling [uploads PR](https://github.com/buildinternet/uploads/pull/851). Read this before changing discovery, implementing a grant this AS does not issue, or expanding DCR default scopes.

## 1. `invalid_client_metadata` / unsupported `grant_type` `device_code`

**Error (AS, DCR `POST /oauth2/register`):** oauth-provider 1.6's register schema is a closed enum (`authorization_code` | `refresh_token` | `client_credentials`). A body that lists `urn:ietf:params:oauth:grant-type:device_code` fails the parse.

**Why a generic client does it.** CIMD/DCR `grant_types` is a capability advertisement. MCPJam's document lists `authorization_code`, `refresh_token`, and `urn:ietf:params:oauth:grant-type:device_code` because its CLI can run the device flow. The authorize URL it actually sends is a normal `response_type=code` + PKCE request. Same class: claude.ai adds `urn:ietf:params:oauth:grant-type:jwt-bearer`.

**Rule.** Intersect advertised grants with the grants this AS issues. Ignore extras at ingest. Enforce at the token endpoint (`unsupported_grant_type`) if someone actually requests a grant you do not implement. Do not treat DCR `grant_types` as a demand that you implement every listed grant.

**What we do.** `rewriteClientMetadataGrantTypes` in `workers/api/src/auth/oauth-grant-types.ts`, applied by `applyOAuthClientInterop` on `/oauth2/register` so `grant_types` is the intersection with `authorization_code`, `refresh_token`, and `client_credentials` before the plugin parses it. Leave the body untouched if `authorization_code` would not remain: ingest still rejects a device-code-only client.

This worker does implement RFC 8628 for the seeded `releases-cli` client (`deviceAuthorization()` in `workers/api/src/auth/index.ts`). oauth-provider's DCR ingest validator does not treat that plugin's grant as supported, so `device_code` stays out of the intersection list.

**Do not.** Add `device_code` or `jwt-bearer` to the DCR supported-grant list without shipping that grant through oauth-provider. Do not implement RFC 8628 for DCR clients just so the metadata document parses. Do not add CIMD as a side effect of this interop fix: that is a 1.7 upgrade.

## 2. `invalid_scope` on authorize or consent

**Error (AS, `/oauth2/authorize` or `/oauth2/consent`):**

```
invalid_scope: The following scopes are invalid: extra, admin
```

**Why a generic client does it.** RFC 9728 / AS metadata `scopes_supported` is the product's full list (`read`, `write`, `admin`, plus identity scopes on the AS). Generic clients copy that list into authorize `scope=` and often add extras (`openid` is already in our list; unknown ids are not). Better Auth then rejects the entire authorize when the request is a superset of the registered list. A non-admin user who later consents to a kitchen-sink that still includes `admin` hits the entitlement gate (`consentScopeViolation`).

**Rule.** [RFC 6749 §3.3](https://datatracker.ietf.org/doc/html/rfc6749#section-3.3): the AS MAY ignore requested scopes it cannot or will not grant. Downscope to the client's registered list and drop unknown ids. At consent (and on the authorization-code blob), also intersect with the signed-in user's `entitledScopes`. Fail only when nothing usable remains. Keep `admin` requestable at authorize so a later admin login can grant it when the client is registered for it.

**What we do.** `workers/api/src/auth/oauth-grant-scopes.ts` intersects `scope=` with `oauth_client.scopes` (fallback: `OAUTH_SCOPES`) on authorize, consent, and the authorization-code blob. Consent and the code blob also strip scopes the user's role cannot hold, so the existing entitlement throw at token issuance is not the first thing a generic client hits. Discovery still lists `admin` in `scopes_supported`.

**Do not.** Expand DCR default scopes to whatever a client puts in `scope=`. Do not fail the whole authorize when a usable subset remains. Do not grant `admin` to a non-admin because the client copied it from discovery.

## 3. `invalid_target` / requested resource not configured

**Error (AS, authorize):**

```
invalid_target: requested resource https://mcp.releases.sh/mcp is not configured
```

**Why a generic client does it.** RFC 9728 protected-resource metadata on this worker advertises `resource` as the origin (`https://mcp.releases.sh`). Some clients copy that string into authorize `resource=` (RFC 8707). Others copy the transport URL (`https://mcp.releases.sh/mcp`, which is what `server.json` remotes and `npx mcp-remote` use). The AS had only listed the origin (plus a trailing-slash variant).

**Rule.** Accept both the origin and the `/mcp` form for every MCP identifier the AS is willing to mint. The MCP resource server must accept both as JWT `aud`. Discovery can keep advertising the origin. Clients that pass `resource=origin` must keep working, and so must clients that pass `origin/mcp`.

**What we do.** `mcpResourceAndOrigin` in `@releases/lib/oauth-jwt`: `oauthValidAudiences` expands every `OAUTH_RESOURCE_AUDIENCES` entry both ways. MCP JWT verification (`workers/mcp/src/auth.ts`) lists the same pair. RFC 9728 on the MCP worker still advertises the origin.

**Do not.** Change discovery to `/mcp` only. Do not drop the origin form. Do not accept arbitrary `resource=` values. Do not expand the API origin (`BETTER_AUTH_URL`) with `/mcp`.

## 4. REST 401 when an MCP tool forwards the Bearer

**Error (sibling API, after a successful MCP call that HTTP-fetches it):** a follows tool (`follow` / `unfollow` / `list_follows` / `get_personalized_feed`) forwards the caller's OAuth JWT to `/v1/me/*` over the `API` service binding. `jwtVerify` failed on `aud`. The token was minted for the MCP resource.

**Why a generic client does it.** The token is minted for the MCP resource (`aud` = `mcp.releases.sh` or `…/mcp`). Follows tools must act as that user against the API; they cannot invent a second credential. The API's accepted audiences were only the API origin.

**Rule.** Same-environment MCP origin and `/mcp` must be accepted audiences on every API gate that already verifies Bearer JWTs. Derive them from `OAUTH_RESOURCE_AUDIENCES` the same way the AS does: staging API never accepts prod MCP `aud`, and vice versa. Keep issuer + API resource ids.

**What we do.** `oauthJwtConfig` in `workers/api/src/middleware/auth.ts` unions the API origin with `mcpResourceAndOrigin` of every `OAUTH_RESOURCE_AUDIENCES` entry. Follows tools still forward `userToken`. On-demand lookup still does not: that path uses `token: null` and falls back to the root key.

**Do not.** Stop forwarding and invent a second auth path for `/v1/me/*`. Do not accept arbitrary audiences. Do not let a staging MCP token verify on prod.

## Hosted `/mcp` credentials

Hosted `/mcp` accepts an OAuth JWT, a `relk_` machine token, a `relu_` user key, or no credential (anonymous read). An API session cookie will not authenticate there.

`serverInfo.icons` points at `https://releases.sh/icon.svg` (`workers/mcp/src/mcp-agent.ts`). Inspector Overview tabs read that field; omitting it shows an empty icon.
