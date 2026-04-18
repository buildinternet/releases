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

export const LATEST_CACHE_TTL_SECONDS = 60;

const KEY_PREFIX = "latest:v1";

export function buildLatestCacheKey(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .sort(([a], [b]) => a.localeCompare(b));
  const qs = entries.map(([k, v]) => `${k}=${v}`).join("&");
  return `${KEY_PREFIX}:${qs}`;
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
