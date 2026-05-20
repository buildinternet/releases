import { getSecret } from "@releases/lib/secrets";
import { isApiTokenShaped, ROOT_SCOPE } from "@buildinternet/releases-core/api-token";
import { verifyApiToken } from "@releases/core-internal/api-token-store";
import { createDb } from "./db.js";
import type { Env } from "./mcp-agent.js";

/** Custom header carrying the staging shared secret. Mirrors workers/api. */
const STAGING_KEY_HEADER = "X-Releases-Staging-Key";

/**
 * Resolved caller identity, attached to the MCP server per request. Mirrors the
 * API worker's AuthContext, plus the raw `token` so the lookup fallback can
 * forward the caller's own credential instead of borrowing the root key.
 */
export type McpIdentity =
  | { kind: "root"; scopes: string[]; tokenId: null; token: null }
  | { kind: "token"; scopes: string[]; tokenId: string; token: string }
  | { kind: "anonymous"; scopes: string[]; tokenId: null; token: null };

export type McpAuthResult = { ok: false; response: Response } | { ok: true; identity: McpIdentity };

const ANONYMOUS: McpIdentity = { kind: "anonymous", scopes: ["read"], tokenId: null, token: null };

function bearer(request: Request): string {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * Resolve the presented Bearer credential to an identity. A `relk_…` token goes
 * to the DB-token path (verified against D1); the static RELEASED_API_KEY maps
 * to root; anything else — no credential, or an invalid/unknown `relk_` token —
 * resolves to anonymous read. No credential is eligible for both paths.
 */
async function resolveIdentity(presented: string, env: Env): Promise<McpIdentity> {
  if (!presented) return ANONYMOUS;
  if (isApiTokenShaped(presented)) {
    if (env.API_TOKENS_DISABLED === "true") return ANONYMOUS;
    const res = await verifyApiToken(createDb(env.DB), presented);
    if (res.ok)
      return { kind: "token", scopes: res.scopes, tokenId: res.tokenId, token: presented };
    // An invalid/unknown token is ignored rather than rejected, so public reads
    // stay open; the staging gate below still applies.
    return ANONYMOUS;
  }
  const rootKey = await getSecret(env.RELEASED_API_KEY).catch(() => null);
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
