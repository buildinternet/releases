/**
 * Read-through KV cache for the MCP worker's hot, non-personalized read tools.
 *
 * The MCP read surface queries D1 directly on every tool call (#1129) — even
 * the tools that mirror KV/edge-cached REST endpoints. AI-agent traffic is the
 * growth surface, so a small read-through cache in front of the token-
 * independent tools collapses repeated identical calls onto one D1 round-trip
 * (#1800 finding 3).
 *
 * Co-tenants the existing `EMBED_CACHE` KV namespace under a dedicated
 * `mcpread:` key prefix (no new infra) — splittable to its own namespace later
 * by swapping the binding. Bump the `vN` segment if a cached tool's response
 * shape changes so stale entries don't leak across deploys.
 *
 * Safety:
 * - **Token-independent tools only.** Only wrap tools whose output is identical
 *   for every caller regardless of auth (the registration site picks these);
 *   never personalized tools (follows / personalized feed).
 * - **Never caches failures.** A tool-level error (`isError`) is passed through
 *   uncached so a transient miss can't be pinned for the whole TTL.
 * - **Fail-open.** No binding, or any KV error, falls through to a live call.
 * - **TTL-only.** No publish-time invalidation is wired from the MCP side
 *   (unlike the REST `invalidateLatestCache`), so the TTL is kept short.
 */

import type { ToolResult } from "../tools";

export interface ReadCacheBinding {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface WaitUntilCtx {
  waitUntil(promise: Promise<unknown>): void;
}

const KEY_PREFIX = "mcpread:v1";

// Short by design: no publish-time invalidation, so staleness is bounded by the
// TTL alone. Long enough to collapse bursty agent polling onto one D1 read.
export const MCP_READ_CACHE_TTL_SECONDS = 60;

const RELATIVE_DATE_RE = /^\d+[dwmy]$/i;

/** Relative `since`/`until` values (e.g. `90d`) move with wall clock — skip cache. */
export function searchParamsCacheable(params: { since?: string; until?: string }): boolean {
  if (params.since && RELATIVE_DATE_RE.test(params.since)) return false;
  if (params.until && RELATIVE_DATE_RE.test(params.until)) return false;
  return true;
}

/**
 * Deterministic JSON for the cache key — recursively sorts object keys so
 * `{a,b}` and `{b,a}` collapse to the same entry. `undefined` values are
 * dropped (Hono/zod omit absent optional params anyway, but this keeps the key
 * stable if a caller passes an explicit `undefined`).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .toSorted(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Build a tool-handler wrapper bound to a KV namespace. Returns identity when
 * the binding is absent so callers can wrap unconditionally.
 *
 * Usage at the registration site:
 *   const cached = makeReadCache(env.EMBED_CACHE, ctx);
 *   server.registerTool(name, schema, cached("get_latest_releases", handler));
 */
export function makeReadCache(kv: ReadCacheBinding | undefined, ctx?: WaitUntilCtx) {
  return function cached<P>(
    toolName: string,
    handler: (params: P) => Promise<ToolResult>,
  ): (params: P) => Promise<ToolResult> {
    if (!kv) return handler;
    return async (params: P): Promise<ToolResult> => {
      const key = `${KEY_PREFIX}:${toolName}:${stableStringify(params)}`;
      const hit = (await kv.get(key, "json").catch(() => null)) as ToolResult | null;
      if (hit !== null && hit !== undefined) return hit;

      const result = await handler(params);
      // Never cache tool-level failures (e.g. not-found, insufficient scope).
      if (!result.isError) {
        const write = kv
          .put(key, JSON.stringify(result), { expirationTtl: MCP_READ_CACHE_TTL_SECONDS })
          .catch(() => {
            // Fail open — next call misses again.
          });
        if (ctx?.waitUntil) ctx.waitUntil(write);
        else await write;
      }
      return result;
    };
  };
}
