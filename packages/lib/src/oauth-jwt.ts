/**
 * Resource-server verification of "Sign in with Releases" OAuth JWT access
 * tokens (#1483). Worker-safe and deliberately free of `better-auth`: the MCP
 * worker must not import the AS (zod-pin reasons — see
 * reference_mcp_worker_zod_pinned_to_sdk_nested), so both resource servers
 * (REST API + MCP) verify tokens here with `jose` + the AS JWKS endpoint.
 *
 * The AS (workers/api oauth-provider plugin) issues RS256 JWTs whose `scope`
 * claim is already clamped to the user's live role at issuance
 * (entitlement.ts → customAccessTokenClaims). The resource server trusts that
 * claim — it never re-derives scope.
 */
import { jwtVerify, createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey } from "jose";

export type { JWTVerifyGetKey } from "jose";

/** The API scope ladder, mirrored from `@buildinternet/releases-core/api-token`. */
const API_SCOPES = new Set(["read", "write", "admin"]);

export interface OAuthJwtConfig {
  /** Expected `iss` — the AS origin (e.g. `https://api.releases.sh`). */
  issuer: string;
  /** Expected `aud` — this resource server's audience (e.g. `https://mcp.releases.sh`). */
  audience: string;
  /** JWKS endpoint. Defaults to `${issuer}/api/auth/jwks`. */
  jwksUrl?: string;
  /**
   * Test seam: a pre-built key resolver (e.g. `createLocalJWKSet(publicJwks)`).
   * When provided, no network JWKS fetch happens. Production passes nothing.
   */
  keyResolver?: JWTVerifyGetKey;
}

/** A successfully verified OAuth access token, projected to what authz needs. */
export interface VerifiedOAuthToken {
  /** `sub` — the user id, or null for an M2M (client_credentials) token. */
  subject: string | null;
  /** API ladder scopes (`read`/`write`/`admin`) carried by the token. */
  scopes: string[];
  /** `https://releases.sh/role` claim, or null. Informational. */
  role: string | null;
  /** The full verified payload, for callers that need other claims. */
  raw: JWTPayload;
}

/**
 * Cheap routing check: does the credential look like a compact JWS (three
 * non-empty base64url segments)? The static root key carries no dots and the
 * `relk_`/`relu_` lanes are prefix-matched first, so a presented credential
 * routes to exactly one verifier. This does NOT validate the token — it only
 * decides whether to attempt JWT verification.
 */
export function isJwtShaped(raw: string): boolean {
  const parts = raw.split(".");
  if (parts.length !== 3) return false;
  return parts.every((p) => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p));
}

/**
 * Extract the API ladder scopes from a verified payload's `scope` claim
 * (space-delimited OAuth string). Identity scopes (`openid`/`profile`/…) are
 * dropped — they are not API authorization. Tolerates a `scope` that is absent,
 * an array (some providers), or non-string (→ no scopes).
 */
export function extractApiScopes(payload: JWTPayload): string[] {
  const raw = (payload as { scope?: unknown }).scope;
  let tokens: string[];
  if (typeof raw === "string") {
    tokens = raw.split(/\s+/);
  } else if (Array.isArray(raw)) {
    tokens = raw.filter((s): s is string => typeof s === "string");
  } else {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (API_SCOPES.has(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** Module-level memo so each JWKS URL is fetched once per cold start / rotation. */
const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function resolveKeySet(config: OAuthJwtConfig): JWTVerifyGetKey {
  if (config.keyResolver) return config.keyResolver;
  const url = config.jwksUrl ?? `${config.issuer.replace(/\/+$/, "")}/api/auth/jwks`;
  let set = remoteKeySets.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    remoteKeySets.set(url, set);
  }
  return set;
}

/**
 * Verify an OAuth JWT access token against the AS JWKS. Checks signature,
 * `iss`, `aud`, and `exp` (jose enforces expiry). Returns the projected token on
 * success, or `null` on ANY failure (bad signature, wrong issuer/audience,
 * expired, malformed) — callers treat null exactly like an invalid opaque
 * token. Never throws.
 */
export async function verifyOAuthJwt(
  token: string,
  config: OAuthJwtConfig,
): Promise<VerifiedOAuthToken | null> {
  try {
    const { payload } = await jwtVerify(token, resolveKeySet(config), {
      issuer: config.issuer,
      audience: config.audience,
    });
    const role = (payload as Record<string, unknown>)["https://releases.sh/role"];
    return {
      subject: typeof payload.sub === "string" ? payload.sub : null,
      scopes: extractApiScopes(payload),
      role: typeof role === "string" ? role : null,
      raw: payload,
    };
  } catch {
    return null;
  }
}

/** Test-only: drop memoized remote key sets so a fresh config re-resolves. */
export function __resetOAuthJwtKeyCache(): void {
  remoteKeySets.clear();
}
