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
 * cached. The route handler stamps a server-trusted sentinel header
 * (X-Releases-Graphql-Admin) after stripping any client-supplied copy
 * of the same header.
 */
import {
  defaultExtractPersistedOperationId,
  usePersistedOperations,
  type ExtractPersistedOperationId,
} from "@graphql-yoga/plugin-persisted-operations";
import { logEvent } from "@releases/lib/log-event";
// The codegen output ships under web/. The API trusts web's manifest because
// they're versioned together in the monorepo — schema.graphql is the same
// pattern. The relative path crosses workspaces but stays inside the repo;
// tsconfig's `include` extends to the JSON file specifically.
import rawManifest from "../../../../web/src/lib/graphql/__generated__/persisted-documents.json" with { type: "json" };

/** Sentinel header set by the route handler after a successful Bearer check. */
export const GRAPHQL_ADMIN_HEADER = "x-releases-graphql-admin";

/**
 * Strip the codegen `sha256:` prefix from manifest keys so it matches the
 * bare hash clients send via `extensions.persistedQuery.sha256Hash` (Apollo
 * APQ wire format).
 */
const HASH_PREFIX = "sha256:";
const MANIFEST: Record<string, string> = Object.fromEntries(
  Object.entries(rawManifest as Record<string, string>).map(([key, doc]) => [
    key.startsWith(HASH_PREFIX) ? key.slice(HASH_PREFIX.length) : key,
    doc,
  ]),
);

/**
 * Hashes whose responses are safe to cache. New entries here MUST come with
 * a matching purge in invalidateLatestCache (see lib/latest-cache.ts) — the
 * 5-minute TTL is the safety net, not the primary freshness mechanism.
 *
 * Today this is the homepage ticker (one query, pinned variables). Look it
 * up by operation name rather than hardcoding the hash so a SELECT-set tweak
 * to the query (which changes the hash) doesn't silently disable caching.
 */
const CACHEABLE_OPERATION_NAMES = ["HomepageTicker"];
function findHashByName(name: string): string | null {
  const needle = `query ${name}(`;
  for (const [hash, doc] of Object.entries(MANIFEST)) {
    if (doc.includes(needle)) return hash;
  }
  return null;
}
export const CACHEABLE_HASHES: ReadonlySet<string> = new Set(
  CACHEABLE_OPERATION_NAMES.map(findHashByName).filter((h): h is string => h !== null),
);

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
  return `gql:v1:${hash}:${v}`;
}

const KEY_PREFIX = "gql:v1:";

export const GRAPHQL_CACHE_TTL_SECONDS = 300;

export interface GraphqlCacheBinding {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Guard that excludes admin callers from cache reads/writes. */
function isAdminRequest(req: Request): boolean {
  return req.headers.get(GRAPHQL_ADMIN_HEADER) === "1";
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
 * through and store the response on the way out.
 *
 * Returns a cached `Response` if present, or `null` if the caller should
 * proceed with normal execution. The companion `storeIfCacheable` writes
 * the response back after yoga finishes.
 */
export async function lookupCached(
  kv: GraphqlCacheBinding | undefined,
  request: Request,
  body: { hash: string | null; variables: unknown },
): Promise<Response | null> {
  if (!kv || !body.hash || !CACHEABLE_HASHES.has(body.hash)) return null;
  if (isAdminRequest(request)) return null;
  const key = buildGraphqlCacheKey(body.hash, body.variables);
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
 */
export async function storeIfCacheable(
  kv: GraphqlCacheBinding | undefined,
  request: Request,
  body: { hash: string | null; variables: unknown },
  responseText: string,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<void> {
  if (!kv || !body.hash || !CACHEABLE_HASHES.has(body.hash)) return;
  if (isAdminRequest(request)) return;
  // Don't cache error responses — the parsed body's `errors` field is the
  // signal the resolver failed. Storing it would pin the failure for the TTL.
  let parsed: { errors?: unknown } | null = null;
  try {
    parsed = JSON.parse(responseText) as { errors?: unknown };
  } catch {
    return;
  }
  if (parsed?.errors) return;

  const key = buildGraphqlCacheKey(body.hash, body.variables);
  const write = kv
    .put(key, responseText, { expirationTtl: GRAPHQL_CACHE_TTL_SECONDS })
    .catch((err) => {
      logEvent("warn", { component: "graphql-cache", event: "put-failed", err, key });
    });
  if (waitUntil) waitUntil(write);
  else await write;
}

/**
 * Purge cached responses for one operation across all known variable shapes.
 *
 * The KV API has no prefix-delete, so we either need a list-and-delete walk
 * (extra reads) or a small set of well-known variable shapes per op. The
 * homepage ticker pins `{ limit: 20, exclude: ["github"] }`, so a single
 * key covers the only writer today. Keep this in sync with the homepage
 * call site (web/src/app/page.tsx).
 */
export const HOMEPAGE_TICKER_VARS = { exclude: ["github"], limit: 20 };

export function purgeKeysForHomepageTicker(): string[] {
  const hash = findHashByName("HomepageTicker");
  if (!hash) return [];
  return [buildGraphqlCacheKey(hash, HOMEPAGE_TICKER_VARS)];
}

export { KEY_PREFIX };
