/**
 * Read-through KV cache for GET /v1/releases/latest.
 *
 * Bump the `v1` segment in the key prefix if the stored response shape
 * changes so stale entries don't leak across deploys.
 */

export interface LatestCacheBinding {
  get(key: string, type: "json"): Promise<unknown>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

// Sized to keep KV write volume bounded under sustained `tail -f` polling —
// each unique cache key costs ~1 write per TTL window under steady traffic.
// See issue #333 for the cost model.
export const LATEST_CACHE_TTL_SECONDS = 300;

const KEY_PREFIX = "latest:v1";

export const DEFAULT_LATEST_COUNT = 10;

export function buildLatestCacheKey(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .toSorted(([a], [b]) => a.localeCompare(b));
  const qs = entries.map(([k, v]) => `${k}=${v}`).join("&");
  return `${KEY_PREFIX}:${qs}`;
}

export interface NormalizedLatestParams {
  count: number;
  sourceId: string | undefined;
  orgId: string | undefined;
  includeCoverage: boolean;
}

// Explicit allowlist of filtered cache keys worth caching beyond the default
// unfiltered shape. Empty by design — add an entry here (matching the
// `buildLatestCacheKey` output for that shape) when analytics show a
// filtered request is a hot enough read to justify its own cache entry.
// Example: the Vercel org page might eventually warrant
//   "latest:v1:count=10&org=org_vercel_id"
export const ALLOWLISTED_CACHE_KEYS: ReadonlySet<string> = new Set<string>();

// The homepage/CLI default request — unfiltered, default count, coverage
// hidden. This is the one key every follow-poller and homepage visitor
// collapses onto, so it's always worth caching.
function isDefaultLatestRequest(p: NormalizedLatestParams): boolean {
  return (
    p.sourceId === undefined &&
    p.orgId === undefined &&
    p.count === DEFAULT_LATEST_COUNT &&
    p.includeCoverage === false
  );
}

export function isCacheableLatestRequest(
  key: string,
  params: NormalizedLatestParams,
): boolean {
  return isDefaultLatestRequest(params) || ALLOWLISTED_CACHE_KEYS.has(key);
}

export async function withLatestCache<T>(
  kv: LatestCacheBinding | undefined,
  key: string,
  waitUntil: ((p: Promise<unknown>) => void) | undefined,
  compute: () => Promise<T>,
): Promise<{ data: T; hit: boolean }> {
  if (!kv) {
    return { data: await compute(), hit: false };
  }

  const cached = await kv.get(key, "json").catch(() => null);
  if (cached !== null && cached !== undefined) {
    return { data: cached as T, hit: true };
  }

  const data = await compute();
  const write = kv
    .put(key, JSON.stringify(data), { expirationTtl: LATEST_CACHE_TTL_SECONDS })
    .catch(() => {
      // Fail open — next request misses again.
    });
  if (waitUntil) waitUntil(write);
  else await write;
  return { data, hit: false };
}
