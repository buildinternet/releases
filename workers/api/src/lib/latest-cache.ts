/**
 * Read-through KV cache for GET /v1/releases/latest.
 *
 * Bump the `v1` segment in the key prefix if the stored response shape
 * changes so stale entries don't leak across deploys.
 */

export interface LatestCacheBinding {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
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
//
// When you add an entry, also extend `invalidateLatestCache` below so the
// purge set matches the cache set — otherwise entries here will be stale
// for up to LATEST_CACHE_TTL_SECONDS after any release to the relevant org.
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

export function isCacheableLatestRequest(key: string, params: NormalizedLatestParams): boolean {
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

/**
 * Environment slice used by `invalidateLatestCache`. Keep in sync with the
 * API worker's `Env.Bindings` and the `FetchOneEnv` used from the cron.
 */
export interface InvalidationEnv {
  LATEST_CACHE?: LatestCacheBinding;
  INVALIDATION_ENABLED?: string;
}

/**
 * Purge the cached /v1/releases/latest default shape after a publish.
 *
 * Called fire-and-forget from the publish sites alongside publishReleaseEvents.
 * Purges are best-effort; the 300s TTL remains the safety net on failure.
 *
 * v1 scope: only the unfiltered default shape (`latest:v1:count=10`) is cached,
 * so that's all this purges. When ALLOWLISTED_CACHE_KEYS grows, extend this
 * helper to purge the matching shapes in the same PR.
 *
 * Kept inline (no queue, no dedicated Worker) because the work is a single
 * KV.delete(). If a second event-driven side-effect emerges, revisit a
 * dedicated consumer — see https://github.com/buildinternet/releases/issues/408
 * for the conversation.
 */
export async function invalidateLatestCache(
  env: InvalidationEnv,
  meta: { nReleases: number; sourceId: string },
): Promise<void> {
  const key = buildLatestCacheKey({ count: String(DEFAULT_LATEST_COUNT) });
  const base = `[invalidation] key=${key} source_id=${meta.sourceId} n_releases=${meta.nReleases}`;

  if (env.INVALIDATION_ENABLED !== "true") {
    console.info(`${base} action=skipped reason=flag_off`);
    return;
  }
  if (!env.LATEST_CACHE) {
    console.info(`${base} action=skipped reason=no_binding`);
    return;
  }
  if (meta.nReleases <= 0) {
    console.info(`${base} action=skipped reason=no_releases`);
    return;
  }

  try {
    await env.LATEST_CACHE.delete(key);
    console.info(`${base} action=purged ok=true`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`${base} action=purged reason=error ok=false error="${msg}"`);
  }
}
