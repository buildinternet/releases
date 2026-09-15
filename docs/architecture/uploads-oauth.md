# uploads.sh OAuth client (workspace connect)

Releases Index is an OAuth **client** of [uploads.sh](https://uploads.sh). A workspace
owner or admin can connect (and disconnect) an uploads account so later features can
read files from that grant. This doc is the connect plumbing only — screenshot proxy
and agent access are follow-ups and are not implemented here.

## How to connect

1. Sign in on Releases Index.
2. Open **Account → Integrations** (`/account/integrations`). The active workspace is
   the one in the workspace switcher.
3. Click **Connect uploads**. The browser is sent to uploads.sh (authorization code +
   PKCE `S256`, scopes `files:read offline_access`).
4. Approve the grant on uploads (pick the uploads workspace if the account has several).
5. uploads redirects to the callback below; Releases Index exchanges the code and stores
   tokens for that workspace.
6. **Disconnect** on the same page removes the local row and best-effort revokes the
   refresh token. Users can also revoke under **Connected apps** on uploads.sh.

Connect and disconnect require workspace `owner` or `admin`. Any member can see
whether the workspace is connected.

## Redirect URIs

The callback is a **web-origin** page (not the API worker) at
`/integrations/uploads/callback` — the same path in prod and local. Do **not**
register `http://localhost:8788/…`: that port is uploads-auth / Releases MCP
preview (`preview:mcp`), not web.

| Environment        | Redirect URI                                               | Notes                                                                    |
| ------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| Production         | `https://releases.sh/integrations/uploads/callback`        | Web origin. Matches the proposed registration.                           |
| Local portless     | `https://releases.localhost/integrations/uploads/callback` | `bun run dev:web`. Trusted as a releases-family Origin.                  |
| Local preview      | `http://localhost:3000/integrations/uploads/callback`      | `preview:web`. Trusted only when `ENVIRONMENT !== "production"`.         |
| Local preview (IP) | `http://127.0.0.1:3000/integrations/uploads/callback`      | Same preview lane; browsers may send this Origin instead of `localhost`. |

Register every URI in the table. If a local or staging origin is missing from
the uploads client, the authorize step fails at uploads.

Override: `UPLOADS_OAUTH_REDIRECT_URI` (full callback URL). Otherwise the start
handler uses a trusted `Origin` (excluding `:8788`), then `WEB_BASE_URL`.

## API

Same principal gate as `/v1/workspaces/*` and `/v1/me/*` (`requireFollowsPrincipal`:
Better Auth session or a user Bearer). Absent from `publicReadRoutes` /
`adminRoutes` (not in the public OpenAPI coverage gate).

| Method   | Path                                                       | Who                                  | Effect                                                      |
| -------- | ---------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------- |
| `GET`    | `/v1/workspaces/:workspaceId/integrations/uploads`         | member+                              | `{ provider, connected, configured, connectedAt, scope }`   |
| `POST`   | `/v1/workspaces/:workspaceId/integrations/uploads/connect` | owner/admin                          | Persist PKCE pending state; `{ authorizeUrl, redirectUri }` |
| `POST`   | `/v1/integrations/uploads/callback`                        | owner/admin of the pending workspace | `{ code, state }` → token exchange                          |
| `DELETE` | `/v1/workspaces/:workspaceId/integrations/uploads`         | owner/admin                          | Revoke-local (and attempt remote revoke)                    |

`configured: false` when the token-encryption key is missing — Connect is
disabled; the rest of the site is unaffected. No feature flag. The client is
public PKCE (`releases-sh`); there is no client secret.

Pending state expires after 10 minutes. Re-clicking Connect replaces the pending
PKCE fields without dropping an already-connected token until the new callback
succeeds.

## Tokens at rest

Access and refresh tokens (and the PKCE verifier while pending) are AES-256-GCM
encrypted with `IDEMPOTENCY_ENCRYPTION_KEY` (32-byte base64 — the existing
encrypted-at-rest key). AAD binds workspace id + provider + field. Plaintext
never lands in D1. Table: `workspace_integrations` (`schema-integrations.ts`).

## Env

| Name                          | Kind   | Default / required                               |
| ----------------------------- | ------ | ------------------------------------------------ |
| `UPLOADS_OAUTH_CLIENT_ID`     | var    | `releases-sh`                                    |
| `UPLOADS_OAUTH_AUTHORIZE_URL` | var    | `https://uploads.sh/api/auth/oauth2/authorize`   |
| `UPLOADS_OAUTH_TOKEN_URL`     | var    | `https://auth.uploads.sh/api/auth/oauth2/token`  |
| `UPLOADS_OAUTH_REVOKE_URL`    | var    | `https://auth.uploads.sh/api/auth/oauth2/revoke` |
| `UPLOADS_OAUTH_SCOPES`        | var    | `files:read offline_access`                      |
| `UPLOADS_OAUTH_REDIRECT_URI`  | var    | unset — derive (see above)                       |
| `IDEMPOTENCY_ENCRYPTION_KEY`  | secret | **required** for connect (token encryption)      |

Discovery (for operators): `https://uploads.sh/.well-known/oauth-authorization-server`.
Authorize is on `uploads.sh` (cookie origin — do not send the browser to
`auth.uploads.sh` for authorize). Token and revoke stay on `auth.uploads.sh` so
the form POST does not hit the web origin's CSRF guard.

## Partner client (`releases-sh`)

Public PKCE client (`token_endpoint_auth_method: none`). No client secret — token
and revoke send `client_id` only. Grant types: `authorization_code` + PKCE
(`S256`) and `refresh_token`. Authorize requests both `files:read` and
`offline_access` (space-separated). The uploads AS only mints a refresh token
when `offline_access` is on the grant.

The prod D1 client row is seeded by
[uploads#984](https://github.com/buildinternet/uploads/pull/984). Live connect
waits on that PR merging and the auth D1 migration deploying.

Allow-list the four redirect URIs in the table above. Do **not** register
`http://localhost:8788/integrations/uploads/callback` — that port is MCP
preview, not the web callback.
