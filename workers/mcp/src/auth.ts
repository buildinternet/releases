import { getSecret, getSecretWithFallback } from "@releases/lib/secrets";
import {
  isApiTokenShaped,
  isUserApiKeyShaped,
  ROOT_SCOPE,
  USER_API_KEY_PREFIX,
} from "@buildinternet/releases-core/api-token";
import { verifyApiToken } from "@releases/core-internal/api-token-store";
import { FLAGS, flag } from "@releases/lib/flags";
import { createDb } from "./db.js";
import type { Env } from "./mcp-agent.js";

/** Custom header carrying the staging shared secret. Mirrors workers/api. */
const STAGING_KEY_HEADER = "X-Releases-Staging-Key";

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

/**
 * Resolved caller identity, attached to the MCP server per request. Mirrors the
 * API worker's AuthContext, plus the raw `token` so the lookup fallback can
 * forward the caller's own credential instead of borrowing the root key.
 */
export type McpIdentity =
  | { kind: "root"; scopes: string[]; tokenId: null; token: null }
  | { kind: "token"; scopes: string[]; tokenId: string; token: string | null }
  | { kind: "anonymous"; scopes: string[]; tokenId: null; token: null };

/**
 * The `api_tokens` tokenId whose `last_used_at` should be recorded for this
 * identity, or null when there is nothing to record: root / anonymous have no
 * row, and relu_ user keys are metered by Better Auth's `apikey` table (a
 * machine-lane UPDATE would touch zero rows). Returns the id (not a boolean) so
 * the caller gets a non-null `string` without re-narrowing.
 */
export function machineTokenIdForUsage(identity: McpIdentity): string | null {
  return identity.kind === "token" && !isUserApiKeyShaped(identity.tokenId)
    ? identity.tokenId
    : null;
}

export type McpAuthResult = { ok: false; response: Response } | { ok: true; identity: McpIdentity };

const ANONYMOUS: McpIdentity = { kind: "anonymous", scopes: ["read"], tokenId: null, token: null };

function bearer(request: Request): string {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * Resolve the presented Bearer credential to an identity. A `relk_…` token goes
 * to the DB-token path (verified against D1); the static RELEASES_API_KEY maps
 * to root; anything else — no credential, or an invalid/unknown `relk_` token —
 * resolves to anonymous read. No credential is eligible for both paths.
 */
async function resolveIdentity(presented: string, env: Env): Promise<McpIdentity> {
  if (!presented) return ANONYMOUS;
  if (isApiTokenShaped(presented)) {
    if (await flag(env.FLAGS, env.API_TOKENS_DISABLED, FLAGS.apiTokensDisabled)) return ANONYMOUS;
    const res = await verifyApiToken(createDb(env.DB), presented);
    if (res.ok)
      return { kind: "token", scopes: res.scopes, tokenId: res.tokenId, token: presented };
    // An invalid/unknown token is ignored rather than rejected, so public reads
    // stay open; the staging gate below still applies.
    return ANONYMOUS;
  }
  const rootKey = await getSecretWithFallback(env.RELEASES_API_KEY, env.RELEASED_API_KEY).catch(
    () => null,
  );
  if (rootKey && presented === rootKey) {
    return { kind: "root", scopes: [ROOT_SCOPE], tokenId: null, token: null };
  }
  return ANONYMOUS;
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: "unauthorized", message: "Missing or invalid staging access key" }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
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
export async function resolveMcpAuth(request: Request, env: Env): Promise<McpAuthResult> {
  const presented = bearer(request);
  const identity = await resolveIdentity(presented, env);

  if (env.STAGING_ACCESS_KEY && request.method !== "OPTIONS") {
    const stagingSecret = await getSecret(env.STAGING_ACCESS_KEY).catch(() => null);
    const passes =
      !stagingSecret ||
      request.headers.get(STAGING_KEY_HEADER) === stagingSecret ||
      presented === stagingSecret ||
      identity.kind === "token" ||
      identity.kind === "root";
    if (!passes) return { ok: false, response: unauthorized() };
  }

  return { ok: true, identity };
}
