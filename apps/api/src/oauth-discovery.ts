import { DCR_GRANT_TYPES } from "./auth/oauth-dcr.js";

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
  // Clamp against the rewritten path. The inbound RFC 8414 form
  // (`/.well-known/oauth-authorization-server/api/auth`) does not end with the
  // metadata suffix; the Better Auth path does. `clampDiscoveryMetadata`
  // also accepts the inserted form, so either URL is safe.
  const clamped = await clampDiscoveryMetadata(url.toString(), upstream);
  const res = new Response(clamped.body, clamped);
  res.headers.set("Access-Control-Allow-Origin", "*");
  return res;
}

/**
 * Only method unauthenticated DCR persists. RFC 8414 treats an omitted list as
 * `client_secret_basic`, so the field is always written.
 */
const PUBLIC_TOKEN_ENDPOINT_AUTH_METHODS = ["none"] as const;

const DISCOVERY_METADATA_SUFFIXES = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
] as const;

function isDiscoveryMetadataPath(pathname: string): boolean {
  return DISCOVERY_METADATA_SUFFIXES.some(
    (suffix) => pathname.endsWith(suffix) || pathname.includes(`${suffix}/`),
  );
}

function listEquals(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, i) => item === expected[i])
  );
}

/**
 * Rewrite OAuth authorization-server and OIDC discovery so the fields a
 * self-registering client copies match what open DCR persists.
 *
 * Better Auth 1.7 fills `token_endpoint_auth_methods_supported` from
 * `getSupportedAuthMethods` (`none` plus `client_secret_basic`,
 * `client_secret_post`, and `private_key_jwt`) and `grant_types_supported`
 * from the grants the token endpoint can issue, including `client_credentials`.
 * Metadata extensions cannot overwrite a key the plugin already wrote.
 * Unauthenticated DCR persists only `token_endpoint_auth_method: "none"` and
 * {@link DCR_GRANT_TYPES} (`sanitizeDcrRegistrationBody`). Vercel Connect's
 * Submit-a-Service test picks `private_key_jwt` from the method list and then
 * fails the token exchange, and it offers an app-token (`client_credentials`)
 * test that a public DCR client cannot redeem. User-token
 * (`authorization_code`) is enough to submit.
 *
 * RFC 8414 treats an omitted auth-method list as `client_secret_basic` and an
 * omitted grant list as `authorization_code` only, so both fields are always
 * written. Introspection and revocation method lists stay as the plugin emits
 * them. Admin-provisioned confidential and M2M clients are unchanged: this
 * rewrites the advertisement, not the token endpoint.
 *
 * CIMD may still store `private_key_jwt` when the metadata document declares
 * it. This clamp does not change that row.
 *
 * A non-discovery response is returned untouched, before its body is read.
 */
export async function clampDiscoveryMetadata(requestUrl: string, res: Response): Promise<Response> {
  if (!res.ok) return res;
  let pathname: string;
  try {
    pathname = new URL(requestUrl).pathname;
  } catch {
    return res;
  }
  if (!isDiscoveryMetadataPath(pathname)) return res;

  let json: Record<string, unknown>;
  try {
    const parsed: unknown = await res.clone().json();
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return res;
    json = parsed as Record<string, unknown>;
  } catch {
    return res;
  }

  let changed = false;
  if (!listEquals(json.token_endpoint_auth_methods_supported, PUBLIC_TOKEN_ENDPOINT_AUTH_METHODS)) {
    json.token_endpoint_auth_methods_supported = [...PUBLIC_TOKEN_ENDPOINT_AUTH_METHODS];
    changed = true;
  }
  if (!listEquals(json.grant_types_supported, DCR_GRANT_TYPES)) {
    json.grant_types_supported = [...DCR_GRANT_TYPES];
    changed = true;
  }
  if (!changed) return res;

  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(json), { status: res.status, headers });
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
