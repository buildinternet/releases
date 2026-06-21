import { getSecret, getSecretWithFallback } from "@releases/lib/secrets";
import {
  isApiTokenShaped,
  isUserApiKeyShaped,
  ROOT_SCOPE,
  USER_API_KEY_PREFIX,
} from "@buildinternet/releases-core/api-token";
import { verifyApiToken } from "@releases/core-internal/api-token-store";
import { FLAGS, flag } from "@releases/lib/flags";
import { consumptionConsumerRef, type ConsumptionRefIdentity } from "@releases/lib/consumption-ref";
import { logEvent } from "@releases/lib/log-event";
import {
  isJwtShaped,
  verifyOAuthJwt,
  type OAuthJwtConfig,
  type JWTVerifyGetKey,
} from "@releases/lib/oauth-jwt";
import {
  DEFAULT_OAUTH_AUDIENCE,
  DEFAULT_OAUTH_ISSUER,
  wwwAuthenticateChallenge,
} from "./well-known.js";
import { createDb } from "./db.js";
import type { Env } from "./mcp-agent.js";

/** Custom header carrying the staging shared secret. Mirrors workers/api. */
const STAGING_KEY_HEADER = "X-Releases-Staging-Key";

/** `tokenId` prefix for an OAuth-JWT principal (#1483). No api_tokens row exists. */
const OAUTH_JWT_TOKEN_PREFIX = "oauth_";

/**
 * Resource-server config for verifying "Sign in with Releases" OAuth JWTs
 * (#1483). The MCP worker can't import better-auth (zod-pin), so it verifies
 * locally with jose against the AS JWKS (`${issuer}/api/auth/jwks`). Issuer +
 * audience are overridable per environment (staging points at api-staging /
 * mcp-staging); both default to prod (shared with the discovery metadata in
 * well-known.ts) so no new config is required there.
 */
function oauthJwtConfig(env: Env): OAuthJwtConfig {
  return {
    issuer: env.OAUTH_JWT_ISSUER || DEFAULT_OAUTH_ISSUER,
    audience: env.OAUTH_JWT_AUDIENCE || DEFAULT_OAUTH_AUDIENCE,
  };
}

/**
 * JSON-RPC methods that are MCP protocol overhead, not billable operations.
 * A presented relu_ key is NOT metered on these.
 */
const NON_BILLABLE_MCP_METHODS = new Set([
  "initialize",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
  "ping",
  "logging/setLevel",
  "completion/complete",
]);

function isBillableMethod(method: unknown): boolean {
  if (typeof method !== "string") return true; // unknown/absent → meter (safe)
  if (method.startsWith("notifications/")) return false; // fire-and-forget
  return !NON_BILLABLE_MCP_METHODS.has(method);
}

/**
 * Decide whether an inbound MCP request should meter a presented relu_ user key.
 * Clones + parses the JSON-RPC body and bills everything except an allowlist of
 * protocol-overhead methods; defaults to billable on parse failure or unknown
 * method (fail-toward-metering). Cloning leaves the ORIGINAL request stream
 * intact for `createMcpHandler` downstream.
 */
export async function isMeteredMcpMethod(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false; // GET = SSE stream, never billable
  try {
    const body = (await request.clone().json()) as unknown;
    if (Array.isArray(body)) {
      return body.some((m) => isBillableMethod((m as { method?: unknown })?.method));
    }
    return isBillableMethod((body as { method?: unknown })?.method);
  } catch {
    return true; // parse failure → meter (safe)
  }
}

/** Coarse principal label for consumption telemetry (#1700). PII-clean — a
 *  TYPE, never an id/email/token. Must match the API worker's labels
 *  (`apiConsumptionPrincipal` in workers/api/src/middleware/auth.ts) so the
 *  Axiom query can union both surfaces. */
export type ConsumptionPrincipal =
  | "anonymous"
  | "machine_token" // relk_
  | "user_key" // relu_
  | "oauth" // OAuth JWT
  | "root";

/** Derive the consumption principal label from a resolved MCP identity. */
export function consumptionPrincipal(identity: McpIdentity): ConsumptionPrincipal {
  if (identity.kind === "root") return "root";
  if (identity.kind === "anonymous") return "anonymous";
  if (isUserApiKeyShaped(identity.tokenId)) return "user_key";
  if (identity.tokenId.startsWith(OAUTH_JWT_TOKEN_PREFIX)) return "oauth";
  return "machine_token";
}

export function mcpConsumptionRefIdentity(identity: McpIdentity): ConsumptionRefIdentity {
  if (identity.kind === "root") return { kind: "root" };
  if (identity.kind === "anonymous") return { kind: "anonymous" };
  return { kind: "token", tokenId: identity.tokenId };
}

/** Emit one consumption event with a hashed `consumerRef` (#1719). */
export async function emitMcpConsumption(identity: McpIdentity, operation: string): Promise<void> {
  const consumerRef = await consumptionConsumerRef(mcpConsumptionRefIdentity(identity));
  logEvent("info", {
    component: "consumption",
    event: "consumption",
    surface: "mcp",
    principal: consumptionPrincipal(identity),
    consumerRef,
    operation,
  });
}

/**
 * Peek the JSON-RPC body once for consumption telemetry (#1700): is this a
 * billable call, and what tool/method is it? Clones the request so the original
 * stream stays intact for `createMcpHandler`. `tool` is the tool name for
 * `tools/call`, else the method; `"batch"` for an array body; `null` on parse
 * failure. Reuses `isBillableMethod` so protocol overhead is never counted.
 */
export async function peekMcpCall(
  request: Request,
): Promise<{ metered: boolean; tool: string | null }> {
  if (request.method !== "POST") return { metered: false, tool: null };
  try {
    const body = (await request.clone().json()) as unknown;
    if (Array.isArray(body)) {
      return {
        metered: body.some((m) => isBillableMethod((m as { method?: unknown })?.method)),
        tool: "batch",
      };
    }
    const method = (body as { method?: unknown })?.method;
    return { metered: isBillableMethod(method), tool: mcpOperationLabel(body) };
  } catch {
    return { metered: true, tool: null }; // parse failure → meter (safe)
  }
}

function mcpOperationLabel(body: unknown): string | null {
  const b = body as { method?: unknown; params?: { name?: unknown } };
  if (typeof b?.method !== "string") return null;
  if (b.method === "tools/call") {
    return typeof b.params?.name === "string" ? b.params.name : "tools/call";
  }
  return b.method;
}

/**
 * Resolved caller identity, attached to the MCP server per request. Mirrors the
 * API worker's AuthContext, plus the raw `token` so the lookup fallback can
 * forward the caller's own credential instead of borrowing the root key.
 */
export type McpIdentity =
  | { kind: "root"; scopes: string[]; tokenId: null; token: null; userToken: null }
  | {
      kind: "token";
      scopes: string[];
      tokenId: string;
      token: string | null;
      /**
       * The raw Bearer credential when this identity is a USER principal (a
       * `relu_` user key or an OAuth JWT) — forwarded by the per-user follows
       * tools to `/v1/me/*` so they act as the user. Null for machine principals
       * (`relk_`), which have no owning user. Distinct from `token` (the
       * on-demand-lookup credential, deliberately null for user lanes so that
       * fallback runs as root, not as the metered user key).
       */
      userToken: string | null;
    }
  | { kind: "anonymous"; scopes: string[]; tokenId: null; token: null; userToken: null };

/**
 * The `api_tokens` tokenId whose `last_used_at` should be recorded for this
 * identity, or null when there is nothing to record: root / anonymous have no
 * row, and relu_ user keys are metered by Better Auth's `apikey` table (a
 * machine-lane UPDATE would touch zero rows). Returns the id (not a boolean) so
 * the caller gets a non-null `string` without re-narrowing.
 */
export function machineTokenIdForUsage(identity: McpIdentity): string | null {
  if (identity.kind !== "token") return null;
  // relu_ user keys (apikey table) and oauth_ JWT principals (no api_tokens row)
  // have nothing to record in the machine-lane last_used path.
  if (isUserApiKeyShaped(identity.tokenId)) return null;
  if (identity.tokenId.startsWith(OAUTH_JWT_TOKEN_PREFIX)) return null;
  return identity.tokenId;
}

export type McpAuthResult = { ok: false; response: Response } | { ok: true; identity: McpIdentity };

const ANONYMOUS: McpIdentity = {
  kind: "anonymous",
  scopes: ["read"],
  tokenId: null,
  token: null,
  userToken: null,
};

function bearer(request: Request): string {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: "unauthorized", message: "Missing or invalid staging access key" }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

function rateLimited(): Response {
  return new Response(
    JSON.stringify({ error: "rate_limited", message: "API key rate limit exceeded" }),
    { status: 429, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * RFC 9728 §5.1 challenge for a presented-but-invalid OAuth JWT — a 401 with a
 * `WWW-Authenticate` header pointing the client at this resource's metadata so a
 * compliant MCP client can discover the AS and re-authenticate (e.g. after token
 * expiry). Only the OAuth JWT lane reaches here; the no-credential, relk_, and
 * relu_ lanes still fall open to anonymous read, so public read is never gated.
 */
function invalidTokenChallenge(request: Request): Response {
  return new Response(
    JSON.stringify({ error: "invalid_token", message: "The access token is invalid or expired" }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": wwwAuthenticateChallenge(request.url),
      },
    },
  );
}

/**
 * Verify + meter a relu_ user key by authenticating it against the API worker's
 * `GET /v1/tokens/me` over the service binding. The API worker's existing auth
 * middleware verifies and meters the key exactly once; we read back the resolved
 * scopes. `token` is null on success — there is no forwardable credential, and
 * the null routes maybeLookup's `authToken ?? rootKey` fallback through the root
 * key (no second meter). 429 → rate-limited; any other non-2xx (401) or error →
 * anonymous read (fail-open, matching the relk_ path).
 */
async function resolveUserKey(
  presented: string,
  env: Env,
): Promise<McpIdentity | { rateLimited: true }> {
  if (!env.API) return ANONYMOUS; // no binding (local dev) — cannot verify
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${presented}` };
    const stagingKey = (await getSecret(env.STAGING_ACCESS_KEY).catch(() => null)) ?? "";
    if (stagingKey) headers[STAGING_KEY_HEADER] = stagingKey;
    const res = await env.API.fetch(
      new Request("https://internal/v1/tokens/me", { method: "GET", headers }),
    );
    if (res.status === 429) return { rateLimited: true };
    if (!res.ok) return ANONYMOUS; // 401 invalid/unknown/revoked → public read
    const body = (await res.json()) as { scopes?: unknown; tokenId?: unknown };
    const scopes = Array.isArray(body.scopes)
      ? body.scopes.filter((s): s is string => typeof s === "string")
      : [];
    if (scopes.length === 0) return ANONYMOUS; // defensive: empty scope never authenticates
    // Stable per-key id from introspection (`relu_${keyId}`) for consumption
    // telemetry (#1719). Fall back to the bare prefix only when an older API omits
    // the field — all keys collapse to one bucket in that case.
    const tokenId =
      typeof body.tokenId === "string" && body.tokenId.length > 0
        ? body.tokenId
        : USER_API_KEY_PREFIX;
    // `userToken: presented` — the raw relu_ key, so the follows tools can act as
    // this user against /v1/me/* (the only place the user credential is needed).
    return {
      kind: "token",
      scopes,
      tokenId,
      token: null,
      userToken: presented,
    };
  } catch (err) {
    logEvent("warn", {
      component: "mcp-auth",
      event: "user-key-introspect-error",
      message: "relu_ introspection failed; treating as anonymous",
      error: err instanceof Error ? err.message : String(err),
    });
    return ANONYMOUS;
  }
}

/**
 * Resolve the presented Bearer credential to an identity. A `relu_…` user key
 * is authenticated via the API service binding (verify + meter once); a `relk_…`
 * token goes to the DB-token path (verified against D1); the static
 * RELEASES_API_KEY maps to root; anything else — no credential, or an
 * invalid/unknown token — resolves to anonymous read.
 */
async function resolveIdentity(
  presented: string,
  env: Env,
  metered: boolean,
  jwtKeyResolver?: JWTVerifyGetKey,
): Promise<McpIdentity | { rateLimited: true } | { invalidToken: true }> {
  if (!presented) return ANONYMOUS;
  if (isUserApiKeyShaped(presented)) {
    if (await flag(env.FLAGS, env.API_TOKENS_DISABLED, FLAGS.apiTokensDisabled)) return ANONYMOUS;
    if (!(await flag(env.FLAGS, env.USER_API_KEYS_ENABLED, FLAGS.userApiKeysEnabled)))
      return ANONYMOUS;
    if (!metered) return ANONYMOUS; // non-billable method (initialize/list) — don't meter
    return resolveUserKey(presented, env);
  }
  if (isApiTokenShaped(presented)) {
    if (await flag(env.FLAGS, env.API_TOKENS_DISABLED, FLAGS.apiTokensDisabled)) return ANONYMOUS;
    const res = await verifyApiToken(createDb(env.DB), presented);
    if (res.ok)
      // relk_ is a machine principal (no owning user) — userToken null.
      return {
        kind: "token",
        scopes: res.scopes,
        tokenId: res.tokenId,
        token: presented,
        userToken: null,
      };
    // An invalid/unknown token is ignored rather than rejected, so public reads
    // stay open; the staging gate below still applies.
    return ANONYMOUS;
  }
  // "Sign in with Releases" OAuth JWT (#1483). Verified locally against the AS
  // JWKS. `token: null` (no forwardable credential) routes the downstream lookup
  // fallback through the root key, same as the relu_ lane, and leaves the staging
  // gate to the staging key. Unlike the relk_/relu_ lanes, a presented-but-invalid
  // OAuth JWT is NOT silently downgraded to anonymous: it returns a discovery
  // challenge (401 + WWW-Authenticate) so a compliant MCP client can re-auth.
  // No-credential requests never reach here, so public read stays open.
  if (isJwtShaped(presented)) {
    const cfg = oauthJwtConfig(env);
    if (jwtKeyResolver) cfg.keyResolver = jwtKeyResolver; // test seam — avoids JWKS fetch
    const verified = await verifyOAuthJwt(presented, cfg);
    if (verified && verified.scopes.length > 0) {
      return {
        kind: "token",
        scopes: verified.scopes,
        tokenId: `${OAUTH_JWT_TOKEN_PREFIX}${verified.subject ?? "m2m"}`,
        token: null,
        // `userToken: presented` — the raw JWT, forwarded by the follows tools to
        // /v1/me/* (which verifies it locally; no second meter, unlike relu_).
        userToken: presented,
      };
    }
    return { invalidToken: true };
  }
  const rootKey = await getSecretWithFallback(env.RELEASES_API_KEY, env.RELEASED_API_KEY).catch(
    () => null,
  );
  if (rootKey && presented === rootKey) {
    return { kind: "root", scopes: [ROOT_SCOPE], tokenId: null, token: null, userToken: null };
  }
  return ANONYMOUS;
}

/**
 * Resolve identity and enforce the staging access gate in one pass. In prod (no
 * STAGING_ACCESS_KEY bound) the gate is skipped and identity flows through. In
 * staging the gate accepts any of: the `X-Releases-Staging-Key` header, a
 * Bearer staging-key, a valid staging-DB `relk_` token, or the static root key
 * — so a managed agent can authenticate with a Bearer token instead of the
 * shared key. CORS preflight (OPTIONS) always passes; an unresolvable staging
 * secret fails open (same as the binding being absent).
 */
export async function resolveMcpAuth(
  request: Request,
  env: Env,
  opts?: { jwtKeyResolver?: JWTVerifyGetKey },
): Promise<McpAuthResult> {
  const presented = bearer(request);
  const metered = await isMeteredMcpMethod(request);
  const resolved = await resolveIdentity(presented, env, metered, opts?.jwtKeyResolver);
  if ("rateLimited" in resolved) return { ok: false, response: rateLimited() };

  // Staging gate FIRST — it must run before any OAuth discovery challenge so
  // mcp-staging stays opaque to invalid-credential probes (the generic 401, not
  // the WWW-Authenticate hint). An invalid OAuth JWT cannot bridge the gate (it
  // has no token identity), so on staging it falls to the generic 401 unless a
  // staging key is also presented. In prod (no STAGING_ACCESS_KEY) the gate is
  // skipped and the challenge below fires as usual.
  if (env.STAGING_ACCESS_KEY && request.method !== "OPTIONS") {
    const stagingSecret = await getSecret(env.STAGING_ACCESS_KEY).catch(() => null);
    const bridges =
      !("invalidToken" in resolved) &&
      // Only the `relk_` token bridge (raw token present) opens the gate, not a
      // `relu_` user identity — those carry `token: null`, so a user key must
      // still supply the staging key to reach mcp-staging.
      ((resolved.kind === "token" && resolved.token !== null) || resolved.kind === "root");
    const passes =
      !stagingSecret ||
      request.headers.get(STAGING_KEY_HEADER) === stagingSecret ||
      presented === stagingSecret ||
      bridges;
    if (!passes) return { ok: false, response: unauthorized() };
  }

  // A presented-but-invalid OAuth JWT → discovery challenge (only reachable once
  // the staging gate, if any, has passed).
  if ("invalidToken" in resolved) return { ok: false, response: invalidTokenChallenge(request) };

  return { ok: true, identity: resolved };
}
