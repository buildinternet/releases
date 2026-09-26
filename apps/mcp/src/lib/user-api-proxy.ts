import { getSecret } from "@releases/lib/secrets";
import type { Env } from "../mcp-agent.js";
import { USER_REQUIRED_TOOLS } from "../user-required-tools.js";

/**
 * Shared plumbing for MCP tools that act on the caller's own account by
 * proxying to the API worker's `/v1/me/*` (and `/v1/workspaces/*`) routes,
 * forwarding the caller's own `userToken` (a `relu_` key or an OAuth JWT).
 * Extracted from `follows-tools.ts` (#1520) so the webhook tools (#1678,
 * #2326) share the exact same forwarding + staging-gate behavior instead of
 * re-implementing it.
 */

const STAGING_KEY_HEADER = "X-Releases-Staging-Key";

/** A `tools/call` result. `isError` surfaces failures to the model as text. */
export type ToolReturn = { content: [{ type: "text"; text: string }]; isError?: boolean };

export function text(body: string, isError = false): ToolReturn {
  return { content: [{ type: "text" as const, text: body }], isError };
}

/**
 * Call a `/v1/me/*` or `/v1/workspaces/*` route on the API worker as the
 * user, forwarding `userToken`. Returns the parsed JSON + status, or
 * `status: 0` when the API binding is absent (local dev). Mirrors
 * `maybeLookup`'s service-binding call, including the staging-gate header so
 * service-bound requests clear the staging access gate.
 */
export async function callMe(
  env: Env,
  userToken: string,
  path: string,
  init: { method: string; body?: string },
): Promise<{ status: number; json: unknown }> {
  if (!env.API) return { status: 0, json: null };
  const headers: Record<string, string> = { Authorization: `Bearer ${userToken}` };
  if (init.body) headers["content-type"] = "application/json";
  const stagingKey = (await getSecret(env.STAGING_ACCESS_KEY).catch(() => null)) ?? "";
  if (stagingKey) headers[STAGING_KEY_HEADER] = stagingKey;
  const res = await env.API.fetch(
    new Request(`https://internal${path}`, { method: init.method, headers, body: init.body }),
  );
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON body (empty 204 etc.) — leave json null
  }
  return { status: res.status, json };
}

/**
 * Shared "sign in required" tool result for the follows/webhook tools.
 * `toolName` MUST be listed in `USER_REQUIRED_TOOLS` (`../user-required-tools.js`)
 * — the same set the HTTP-layer sign-in challenge in `auth.ts` consults to
 * decide which anonymous `tools/call`s get a 401 instead of falling through
 * here — or this throws, so a new user-gated tool can't silently miss the
 * challenge. `message` is the tool-family-specific guidance text (mentions
 * both the connector-settings sign-in flow and the Bearer-key fallback).
 */
export function userRequired(toolName: string, message: string): ToolReturn {
  if (!USER_REQUIRED_TOOLS.has(toolName)) {
    throw new Error(
      `userRequired("${toolName}") called for a tool missing from USER_REQUIRED_TOOLS — ` +
        "add it there so the anonymous sign-in challenge (auth.ts) covers it too.",
    );
  }
  return text(message, true);
}

/** Extract `{ error: { message } }` from a standardized error envelope, if present. */
export function apiErrorMessage(json: unknown): string | null {
  if (json && typeof json === "object" && "error" in json) {
    const err = (json as { error?: unknown }).error;
    if (err && typeof err === "object" && "message" in err) {
      const message = (err as { message?: unknown }).message;
      if (typeof message === "string" && message) return message;
    }
  }
  return null;
}
