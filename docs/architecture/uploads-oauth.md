# uploads.sh OAuth client (workspace connect)

Releases Index is an OAuth **client** of [uploads.sh](https://uploads.sh). A workspace
owner or admin can connect (and disconnect) an uploads account so later features can
read files from that grant. This doc is the connect plumbing only — screenshot proxy
and agent access are follow-ups and are not implemented here.

## How to connect

1. Sign in on Releases Index.
2. Open **Account → Integrations** (`/account/integrations`). The active workspace is
   the one in the workspace switcher.
3. Click **Connect Uploads**. The browser is sent to uploads.sh (authorization code +
   PKCE `S256`, scopes `files:read offline_access`).
4. Approve the grant on Uploads (pick the uploads workspace if the account has several).
5. Uploads redirects to the callback below; Releases Index exchanges the code, decodes
   the access-token JWT `workspace` claim (else the first `workspaces[]` slug), and
   stores tokens plus that slug for the Index workspace.
6. **Disconnect** on the same page removes the local row and best-effort revokes the
   refresh token at `https://auth.uploads.sh/api/auth/oauth2/revoke`. Users can also
   revoke under **Connected apps** on Uploads.

Connect and disconnect require workspace `owner` or `admin`. Any member can see
whether the workspace is connected.

## Redirect URIs

The callback is a **web-origin** page (not the API worker) at
`/integrations/uploads/callback` — the same path in prod and local. Do **not**
register `http://localhost:8788/…`: that port is uploads-auth / Releases MCP
preview (`preview:mcp`), not web.

| Environment        | Redirect URI                                               | Notes                                                                    |
| ------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| Production         | `https://releases.sh/integrations/uploads/callback`        | Registered on the official `releases-sh` client.                         |
| Local portless     | `https://releases.localhost/integrations/uploads/callback` | `bun run dev:web`. Trusted as a releases-family Origin.                  |
| Local preview      | `http://localhost:3000/integrations/uploads/callback`      | `preview:web`. Trusted only when `ENVIRONMENT !== "production"`.         |
| Local preview (IP) | `http://127.0.0.1:3000/integrations/uploads/callback`      | Same preview lane; browsers may send this Origin instead of `localhost`. |

These four URIs are allow-listed on the live `releases-sh` client. If a local
or staging origin is missing from the uploads client, the authorize step fails
at uploads.

Override: `UPLOADS_OAUTH_REDIRECT_URI` (full callback URL). Otherwise the start
handler uses a trusted `Origin` (excluding `:8788`), then `WEB_BASE_URL`.

## API

Same principal gate as `/v1/workspaces/*` and `/v1/me/*` (`requireFollowsPrincipal`:
Better Auth session or a user Bearer). Absent from `publicReadRoutes` /
`adminRoutes` (not in the public OpenAPI coverage gate).

| Method   | Path                                                       | Who                                  | Effect                                                                      |
| -------- | ---------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| `GET`    | `/v1/workspaces/:workspaceId/integrations/uploads`         | member+                              | `{ provider, connected, configured, connectedAt, scope, uploadsWorkspace }` |
| `POST`   | `/v1/workspaces/:workspaceId/integrations/uploads/connect` | owner/admin                          | Persist PKCE pending state; `{ authorizeUrl, redirectUri }`                 |
| `POST`   | `/v1/integrations/uploads/callback`                        | owner/admin of the pending workspace | `{ code, state }` → token exchange                                          |
| `DELETE` | `/v1/workspaces/:workspaceId/integrations/uploads`         | owner/admin                          | Revoke-local (and attempt remote revoke)                                    |

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
The connected uploads workspace slug is stored in `provider_workspace` (wire:
`uploadsWorkspace`) after the token exchange — decoded from the access-token JWT,
no extra Uploads API call.

The `refresh_token` grant (`offline_access` on authorize) is implemented by
`refreshUploadsAccessToken` / `ensureFreshUploadsAccessToken`. File-read follow-ups
should call `ensureFreshUploadsAccessToken` so an expired access token is rotated
and persisted (a new refresh token from the AS replaces the stored one; an omitted
refresh token keeps the existing row).

## Operator setup

The official client is live in prod uploads D1
([uploads#984](https://github.com/buildinternet/uploads/pull/984)). No new
Secrets Store binding and no dashboard client-id var.

**Already provisioned — do not add:**

| Name                          | Where                                   | Role                                                                |
| ----------------------------- | --------------------------------------- | ------------------------------------------------------------------- |
| `IDEMPOTENCY_ENCRYPTION_KEY`  | Secrets Store (`secrets_store_secrets`) | Encrypts tokens at rest. Already bound on api prod + staging.       |
| `WEB_BASE_URL`                | wrangler var                            | Prod fallback redirect origin (`https://releases.sh`). Already set. |
| `UPLOADS_OAUTH_AUTHORIZE_URL` | wrangler var                            | `https://uploads.sh/api/auth/oauth2/authorize`                      |
| `UPLOADS_OAUTH_TOKEN_URL`     | wrangler var                            | `https://auth.uploads.sh/api/auth/oauth2/token`                     |
| `UPLOADS_OAUTH_REVOKE_URL`    | wrangler var                            | `https://auth.uploads.sh/api/auth/oauth2/revoke`                    |
| `UPLOADS_OAUTH_SCOPES`        | wrangler var                            | `files:read offline_access`                                         |

**Hardcoded (not a wrangler var, not a secret):**

| Name      | Value         | Notes                                                                                                           |
| --------- | ------------- | --------------------------------------------------------------------------------------------------------------- |
| Client id | `releases-sh` | Public PKCE. Same pattern as `releases-cli`. Optional override: `UPLOADS_OAUTH_CLIENT_ID` (forks / tests only). |

**Local only** (`apps/api/.dev.vars`; wrangler dev cannot read Secrets Store):

| Name                         | Notes                                                           |
| ---------------------------- | --------------------------------------------------------------- |
| `IDEMPOTENCY_ENCRYPTION_KEY` | 32-byte base64. Connect returns 503 if this is missing locally. |

There is **no** `UPLOADS_OAUTH_CLIENT_SECRET`. Authorize stays on `uploads.sh`
(cookie origin — do not send the browser to `auth.uploads.sh` for authorize).
Token and revoke stay on `auth.uploads.sh` so the form POST does not hit the
web origin's CSRF guard.

Discovery (for operators): `https://uploads.sh/.well-known/oauth-authorization-server`.

## Partner client (`releases-sh`)

Public PKCE client (`token_endpoint_auth_method: none`). No client secret — token
and revoke send `client_id` only. Grant types: `authorization_code` + PKCE
(`S256`) and `refresh_token`. Authorize requests both `files:read` and
`offline_access` (space-separated). The uploads AS only mints a refresh token
when `offline_access` is on the grant.

The four redirect URIs in the table above are allow-listed on the live client.
Do **not** register `http://localhost:8788/integrations/uploads/callback` — that
port is MCP preview, not the web callback.
