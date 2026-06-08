# auth.md — Releases Agent Authentication

Releases is a changelog registry for AI agents and developers. **Most read
access is public and needs no authentication** — you can query the REST API or
the MCP server anonymously. Authentication is only required for write and admin
operations. When you do need a token, Releases is an OAuth 2.0 / OpenID Connect
provider ("Sign in with Releases").

## TL;DR

- **Public reads:** no auth. Call the REST API (`https://api.releases.sh`) or the
  MCP server (`https://mcp.releases.sh/mcp`) directly.
- **Authenticated calls:** obtain an OAuth access token from the authorization
  server below and send it as `Authorization: Bearer <token>` to
  `https://api.releases.sh`.

## Discovery

| Document                               | URL                                                              |
| -------------------------------------- | ---------------------------------------------------------------- |
| OpenID Connect discovery               | `https://api.releases.sh/.well-known/openid-configuration`       |
| OAuth 2.0 AS metadata (RFC 8414)       | `https://api.releases.sh/.well-known/oauth-authorization-server` |
| Protected-resource metadata (RFC 9728) | `https://api.releases.sh/.well-known/oauth-protected-resource`   |

- **Issuer:** `https://api.releases.sh/api/auth`
- **Resource (token audience):** `https://api.releases.sh`
- **JWKS:** `https://api.releases.sh/api/auth/jwks`

## Authentication

Authorization Code with PKCE (`S256` is required):

1. **Authorize:** `https://api.releases.sh/api/auth/oauth2/authorize`
2. **Exchange the code:** `https://api.releases.sh/api/auth/oauth2/token`
3. **Call the API** with `Authorization: Bearer <access_token>`.

The `client_credentials` and `refresh_token` grants are also supported. Access
tokens are JWTs (EdDSA) — verify them against the JWKS endpoint above.

**Scopes:** `read` ⊂ `write` ⊂ `admin` (plus the OIDC `openid`, `profile`,
`email`, and `offline_access` scopes). A token's scope ceiling is set by the
user's role; most agents only need `read`.

## Client registration

OAuth clients are provisioned by the Releases operators — **dynamic client
registration (RFC 7591) is intentionally disabled**. To register an agent or
application, email <security@releases.sh> or open an issue at
<https://github.com/buildinternet/releases>. Human users can also mint a
read-only personal API key from the web app.

## Reference

- REST API documentation: <https://releases.sh/docs/api>
- MCP server: <https://releases.sh/docs/api/mcp>
