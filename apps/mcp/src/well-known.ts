/**
 * OAuth discovery surface for the MCP worker. The MCP authorization spec
 * (2025-06-18) requires an MCP server, acting as an OAuth 2.1 resource server,
 * to (a) serve RFC 9728 protected-resource metadata and (b) point clients at it
 * via a `WWW-Authenticate` challenge. A standards-compliant client only sends
 * the RFC 8707 `resource` parameter — which is what makes the AS mint a JWT
 * instead of an opaque token — after discovering the canonical resource URI and
 * its authorization server here. Without this surface the JWT lane (#1483) never
 * engages for an off-the-shelf client.
 *
 * Deliberately free of any auth/DB import so it can be served on the public,
 * gate-exempt path (before `resolveMcpAuth`), like `/robots.txt`.
 */
import type { Env } from "./mcp-agent.js";

/**
 * Prod defaults for the OAuth resource-server config — the single source of
 * truth shared with the JWT verifier wiring in `auth.ts`. The MCP audience is
 * the bare origin (an explicitly-valid RFC 8707 canonical URI and already an
 * allowed audience in the AS's `OAUTH_RESOURCE_AUDIENCES`); the issuer carries
 * the `/api/auth` basePath to match the token `iss` and the discovery doc.
 */
export const DEFAULT_OAUTH_AUDIENCE = "https://mcp.releases.sh";
export const DEFAULT_OAUTH_ISSUER = "https://api.releases.sh/api/auth";

/**
 * The configured MCP audiences. `OAUTH_JWT_AUDIENCE` may list several bare
 * origins, comma-separated, when the worker answers on more than one host
 * (prod: agents.releases.sh and the mcp.releases.sh alias). The first entry is
 * the default advertised resource.
 */
export function oauthAudiences(env: Env): string[] {
  const list = (env.OAUTH_JWT_AUDIENCE ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : [DEFAULT_OAUTH_AUDIENCE];
}

/**
 * The audience to advertise for a request: the configured audience on the same
 * origin the client connected to, so RFC 9728 §3.3's "resource must match the
 * URL used" check passes on every host. Falls back to the first audience.
 */
export function resourceForRequest(env: Env, requestUrl?: string): string {
  const audiences = oauthAudiences(env);
  if (requestUrl) {
    const origin = new URL(requestUrl).origin;
    const match = audiences.find((aud) => {
      try {
        return new URL(aud).origin === origin;
      } catch {
        return false;
      }
    });
    if (match) return match;
  }
  return audiences[0];
}

/** RFC 9728 metadata path (root form; the canonical resource is the bare origin). */
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

/** RFC 9728 OAuth 2.0 Protected Resource Metadata document. */
export interface ProtectedResourceMetadata {
  /** The canonical resource identifier — equals the resource server's verified `aud`. */
  resource: string;
  /** Issuer URL(s) of the authorization server(s) that issue tokens for this resource. */
  authorization_servers: string[];
  /** API ladder scopes the resource recognizes. */
  scopes_supported: string[];
  /** How a bearer token may be presented. */
  bearer_methods_supported: string[];
}

/**
 * Build the protected-resource metadata document from the OAuth resource-server
 * env vars, falling back to the prod defaults the auth path uses so the two
 * surfaces never disagree. `resource` is the configured audience (bare origin)
 * matching the request's host, when one does.
 * The AS and this worker also accept the `/mcp` transport URL as `aud`; see
 * mcp-cimd-interop.md.
 */
export function buildProtectedResourceMetadata(
  env: Env,
  requestUrl?: string,
): ProtectedResourceMetadata {
  return {
    resource: resourceForRequest(env, requestUrl),
    authorization_servers: [env.OAUTH_JWT_ISSUER || DEFAULT_OAUTH_ISSUER],
    scopes_supported: ["read", "write", "admin"],
    bearer_methods_supported: ["header"],
  };
}

/** Absolute metadata URL for a request: the request origin + the well-known path. */
export function protectedResourceMetadataUrl(requestUrl: string): string {
  return new URL(PROTECTED_RESOURCE_PATH, requestUrl).href;
}

/**
 * Does this request path want the protected-resource metadata? Matches both the
 * root form and the RFC 9728 §3.1 path-suffixed form (`…/oauth-protected-resource/mcp`),
 * which some clients derive from the `/mcp` transport endpoint.
 */
export function isProtectedResourceMetadataPath(pathname: string): boolean {
  return pathname === PROTECTED_RESOURCE_PATH || pathname === `${PROTECTED_RESOURCE_PATH}/mcp`;
}

/** Build the public 200 JSON response carrying the protected-resource metadata. */
export function protectedResourceMetadataResponse(env: Env, requestUrl?: string): Response {
  return Response.json(buildProtectedResourceMetadata(env, requestUrl), {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}

/**
 * RFC 9728 §5.1 `WWW-Authenticate` challenge for an invalid OAuth token, pointing
 * the client at this resource's metadata so it can discover the AS and re-auth.
 */
export function wwwAuthenticateChallenge(requestUrl: string): string {
  return `Bearer error="invalid_token", resource_metadata="${protectedResourceMetadataUrl(requestUrl)}"`;
}

/**
 * RFC 6750 §3.1 `WWW-Authenticate` challenge for a MISSING bearer token — the
 * sibling of `wwwAuthenticateChallenge` above, which covers a presented-but-
 * *invalid* token. Per the spec, a server SHOULD omit `error=` when no
 * credential was presented at all (it isn't "invalid", it's simply absent);
 * `scope` names what would satisfy the gated tool. Used by the anonymous
 * sign-in step-up challenge (#2408) when a caller with no credential invokes a
 * user-gated tool (see `user-required-tools.ts`).
 */
export function missingTokenChallenge(requestUrl: string, scope = "read"): string {
  return `Bearer scope="${scope}", resource_metadata="${protectedResourceMetadataUrl(requestUrl)}"`;
}
