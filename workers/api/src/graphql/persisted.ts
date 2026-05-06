/**
 * Persisted operations + KV response cache for /v1/graphql.
 *
 * The web app sends only a sha256 hash of its query (codegen-time). The
 * server maps the hash back to the document via a manifest committed to the
 * repo by `bun web/codegen.ts`. Unknown hashes reject for non-admin callers.
 *
 * Two responsibilities live here together because they share the manifest
 * and key format:
 *
 *   1. usePersistedOperations plugin wiring — protocol-level allowlist.
 *   2. KV read-through cache — wraps yoga.fetch for the (hash, variables)
 *      combinations we know are safe to cache.
 *
 * Admin callers (Authorization: Bearer matches RELEASED_API_KEY) bypass
 * both: they may send arbitrary documents and their responses are not
 * cached. The route handler stamps the X-Releases-Graphql-Admin sentinel
 * after stripping any client-supplied copy.
 */
import {
  defaultExtractPersistedOperationId,
  usePersistedOperations,
  type ExtractPersistedOperationId,
} from "@graphql-yoga/plugin-persisted-operations";
import { logEvent } from "@releases/lib/log-event";
import type { LatestCacheBinding } from "../lib/latest-cache.js";
// The codegen output ships under web/. The API trusts web's manifest because
// they're versioned together in the monorepo — schema.graphql is the same
// pattern. The relative path crosses workspaces but stays inside the repo;
// tsconfig's `include` extends to the JSON file specifically.
import rawManifest from "../../../../web/src/lib/graphql/__generated__/persisted-documents.json" with { type: "json" };

/**
 * Sentinel header set by the route handler when the request should bypass
 * the persisted-operations gate and the KV cache. Two conditions stamp it:
 * a successful Bearer auth (real admin), or a non-production deployment
 * (so GraphiQL stays usable without an API key in dev/staging). The header
 * is stripped from inbound requests before re-stamping, so it can't be
 * spoofed by callers.
 */
export const GRAPHQL_ADMIN_HEADER = "x-releases-graphql-admin";

// Bare sha256 (no `sha256:` prefix) is what Apollo APQ wire format uses.
// Keep in sync with web/src/lib/graphql/client.ts which strips the same
// prefix on the way out.
const HASH_PREFIX = "sha256:";
const stripHashPrefix = (key: string) =>
  key.startsWith(HASH_PREFIX) ? key.slice(HASH_PREFIX.length) : key;

const MANIFEST: Record<string, string> = Object.fromEntries(
  Object.entries(rawManifest as Record<string, string>).map(([key, doc]) => [
    stripHashPrefix(key),
    doc,
  ]),
);

// Operation-name → hash lookup, built once at module load. Used by
// CACHEABLE_HASHES and by purge helpers below — pre-building avoids
// re-scanning the manifest on every cache invalidation.
const HASH_BY_OP_NAME: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [hash, doc] of Object.entries(MANIFEST)) {
    const match = doc.match(/\bquery\s+(\w+)\s*\(/);
    if (match?.[1]) m.set(match[1], hash);
  }
  return m;
})();

/**
 * Hashes whose responses are safe to cache. New entries here MUST come with
 * a matching purge in invalidateLatestCache (see lib/latest-cache.ts) — the
 * 5-minute TTL is the safety net, not the primary freshness mechanism.
 *
 * Look up by operation name rather than hardcoding the hash so a SELECT-set
 * tweak to the query (which changes the hash) doesn't silently disable
 * caching.
 */
const CACHEABLE_OPERATION_NAMES = ["HomepageTicker"];
export const CACHEABLE_HASHES: ReadonlySet<string> = new Set(
  CACHEABLE_OPERATION_NAMES.map((n) => HASH_BY_OP_NAME.get(n)).filter(
    (h): h is string => h !== undefined,
  ),
);

const KEY_PREFIX = "gql:v1:";

/**
 * Stable cache key per (hash, variables). Variables are sorted by key so
 * `{a:1,b:2}` and `{b:2,a:1}` collapse onto one entry.
 */
export function buildGraphqlCacheKey(hash: string, variables: unknown): string {
  const v =
    variables && typeof variables === "object"
      ? JSON.stringify(
          Object.fromEntries(
            Object.entries(variables as Record<string, unknown>).toSorted(([a], [b]) =>
              a.localeCompare(b),
            ),
          ),
        )
      : "";
  return `${KEY_PREFIX}${hash}:${v}`;
}

export const GRAPHQL_CACHE_TTL_SECONDS = 300;

// Same KV-shaped contract as /v1/releases/latest's read-through cache —
// reuse the type so any future widening (e.g. metadata, list) lands once.
export type GraphqlCacheBinding = LatestCacheBinding;

function isAdminRequest(req: Request): boolean {
  return req.headers.get(GRAPHQL_ADMIN_HEADER) === "1";
}

interface CacheBody {
  hash: string | null;
  variables: unknown;
}

/**
 * Returns the cache key when the request is a cache candidate, or null when
 * it's not (no binding, no hash, hash not in allowlist, or admin caller).
 * Centralizes the predicate shared by lookupCached + storeIfCacheable.
 */
function cacheKeyFor(
  kv: GraphqlCacheBinding | undefined,
  request: Request,
  body: CacheBody,
): string | null {
  if (!kv || !body.hash || !CACHEABLE_HASHES.has(body.hash)) return null;
  if (isAdminRequest(request)) return null;
  return buildGraphqlCacheKey(body.hash, body.variables);
}

/**
 * Yoga plugin enforcing persisted operations. Non-admin callers must send a
 * known hash; admin callers (sentinel header set) may send arbitrary
 * documents (GraphiQL playground, ad-hoc debugging).
 */
export function persistedOperationsPlugin() {
  // Custom extractor: skip lookup for admin requests sending raw documents,
  // so they pass through untouched. The plugin's own logic handles the
  // hash-bearing case for everyone else.
  const extract: ExtractPersistedOperationId = (params, request, context) => {
    if (isAdminRequest(request) && typeof params.query === "string") return null;
    return defaultExtractPersistedOperationId(params, request, context);
  };
  return usePersistedOperations({
    extractPersistedOperationId: extract,
    allowArbitraryOperations: (request) => isAdminRequest(request),
    getPersistedOperation: (hash) => MANIFEST[hash] ?? null,
  });
}

/**
 * Read-through KV cache. Lookup happens before yoga runs; on miss we fall
 * through and `storeIfCacheable` writes the response back on the way out.
 */
export async function lookupCached(
  kv: GraphqlCacheBinding | undefined,
  request: Request,
  body: CacheBody,
): Promise<Response | null> {
  const key = cacheKeyFor(kv, request, body);
  if (!key || !kv) return null;
  const cached = await kv.get(key, "json").catch(() => null);
  if (cached === null || cached === undefined) return null;
  return new Response(JSON.stringify(cached), {
    headers: { "content-type": "application/json", "x-releases-cache": "hit" },
  });
}

/**
 * Store the response body in KV when the request was cacheable. Caller
 * passes the raw text so we don't double-parse. Uses waitUntil where
 * available; otherwise awaits inline so test runs see the write.
 *
 * The caller is expected to gate on `CACHEABLE_HASHES.has(hash)` before
 * even reading the response body — this function re-checks defensively
 * so it's safe to call unconditionally, but the read-and-discard cost
 * for non-cacheable hashes belongs upstream.
 */
export async function storeIfCacheable(
  kv: GraphqlCacheBinding | undefined,
  request: Request,
  body: CacheBody,
  responseText: string,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<void> {
  const key = cacheKeyFor(kv, request, body);
  if (!key || !kv) return;
  // Don't cache error responses — the parsed body's `errors` field is the
  // signal the resolver failed. Storing it would pin the failure for the TTL.
  let parsed: { errors?: unknown } | null = null;
  try {
    parsed = JSON.parse(responseText) as { errors?: unknown };
  } catch {
    return;
  }
  if (parsed?.errors) return;

  const write = kv
    .put(key, responseText, { expirationTtl: GRAPHQL_CACHE_TTL_SECONDS })
    .catch((err) => {
      logEvent("warn", { component: "graphql-cache", event: "put-failed", err, key });
    });
  if (waitUntil) waitUntil(write);
  else await write;
}

/**
 * Purge cached responses for the homepage ticker after a publish.
 *
 * The KV API has no prefix-delete, so we either need a list-and-delete walk
 * (extra reads) or well-known variable shapes per op. The homepage ticker
 * pins `{ limit: 20, exclude: ["github"] }`, so one key covers the only
 * writer today. Keep in sync with web/src/app/page.tsx.
 */
export const HOMEPAGE_TICKER_VARS = { exclude: ["github"], limit: 20 };

export function purgeKeysForHomepageTicker(): string[] {
  const hash = HASH_BY_OP_NAME.get("HomepageTicker");
  if (!hash) return [];
  return [buildGraphqlCacheKey(hash, HOMEPAGE_TICKER_VARS)];
}

export { KEY_PREFIX };
