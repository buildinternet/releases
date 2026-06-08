/** Minimal shape this helper needs from a Better Auth instance. */
interface AuthHandler {
  handler: (req: Request) => Promise<Response>;
}

/**
 * Forward an apex OAuth/OIDC discovery request to the Better Auth handler, which
 * serves the metadata under `/api/auth/.well-known/...`. OAuth clients (Claude,
 * ChatGPT, MCP Inspector, …) fetch the ORIGIN path; this rewrites to the Better
 * Auth path and stamps a wildcard origin so a cross-origin fetch (no credentials)
 * can read the response. No `Allow-Methods` here — that header only matters on the
 * OPTIONS preflight, which the global CORS layer answers, never on this GET.
 */
export async function forwardWellKnown(
  auth: AuthHandler,
  wellKnown: "oauth-authorization-server" | "openid-configuration",
  reqUrl: string,
  headers: Headers,
): Promise<Response> {
  const url = new URL(reqUrl);
  url.pathname = `/api/auth/.well-known/${wellKnown}`;
  const upstream = await auth.handler(new Request(url, { headers }));
  const res = new Response(upstream.body, upstream);
  res.headers.set("Access-Control-Allow-Origin", "*");
  return res;
}

/** Prod fallback origin for this AS/resource server — mirrors auth/index.ts's DEFAULT_AUTH_ORIGIN. */
const DEFAULT_AS_ORIGIN = "https://api.releases.sh";

/** RFC 9728 OAuth 2.0 Protected Resource Metadata document. */
export interface ProtectedResourceMetadata {
  /** Canonical resource identifier — equals this resource server's verified `aud`. */
  resource: string;
  /** Issuer URL(s) of the authorization server(s) that issue tokens for this resource. */
  authorization_servers: string[];
  /** API ladder scopes the resource recognizes. */
  scopes_supported: string[];
  /** How a bearer token may be presented. */
  bearer_methods_supported: string[];
}

/**
 * RFC 9728 protected-resource metadata for the REST API worker, which is itself
 * an OAuth resource server (#1483 — its auth middleware verifies "Sign in with
 * Releases" JWTs whose `aud` is this origin). Mirrors the MCP worker's
 * `buildProtectedResourceMetadata`. `resource` is the API origin — the RFC 8707
 * identifier a client echoes back, equal to the verified `aud` (see
 * `oauthJwtConfig` in middleware/auth.ts); the authorization server is that origin
 * plus the `/api/auth` basePath, matching the token `iss` and the AS discovery
 * doc. Derived from `BETTER_AUTH_URL` so staging is automatically correct, falling
 * back to the prod origin the auth path hard-codes so the two never disagree.
 */
export function buildApiProtectedResourceMetadata(env: {
  BETTER_AUTH_URL?: string;
}): ProtectedResourceMetadata {
  let origin = DEFAULT_AS_ORIGIN;
  if (env.BETTER_AUTH_URL) {
    try {
      origin = new URL(env.BETTER_AUTH_URL).origin;
    } catch {
      /* keep default */
    }
  }
  return {
    resource: origin,
    authorization_servers: [`${origin}/api/auth`],
    scopes_supported: ["read", "write", "admin"],
    bearer_methods_supported: ["header"],
  };
}
