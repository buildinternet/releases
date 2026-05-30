/**
 * Read-through KV cache for GET /v1/releases/latest.
 *
 * Bump the `vN` segment in the key prefix if the stored response shape or
 * default-filter semantics change so stale entries don't leak across deploys.
 * v2: default response excludes prereleases (was previously unfiltered).
 */

import { logEvent } from "@releases/lib/log-event";
import { purgeKeysForHomepageTicker } from "../graphql/persisted.js";
import { FLAGS, flag, type FlagshipBinding } from "@releases/lib/flags";

export interface LatestCacheBinding {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

// Sized to keep KV write volume bounded under sustained `tail -f` polling —
// each unique cache key costs ~1 write per TTL window under steady traffic.
// See issue #333 for the cost model.
export const LATEST_CACHE_TTL_SECONDS = 300;

const KEY_PREFIX = "latest:v2";

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
  /** Source types excluded from the result, sorted ascending. */
  excludeSourceTypes: string[];
  /** Canonical ISO `since`/`until` window bounds, when supplied. */
  since: string | undefined;
  until: string | undefined;
}

/**
 * Cacheable default shapes — every shape in this list is read-through KV
 * cached and purged by `invalidateLatestCache`. Two requests every poller
 * and homepage visitor collapse onto:
 *
 * - CLI / `tail -f` default: count=10, no exclude.
 * - Homepage ticker: count=20, exclude=github (drops high-volume SDK noise
 *   without round-tripping it through the wire).
 *
 * Add a new entry here when a filtered shape becomes a hot enough read to
 * justify its own cache entry. The `excludeSourceTypes` array MUST be
 * sorted — it's compared element-by-element against the (already sorted)
 * normalized request params.
 */
export const HOMEPAGE_LATEST_COUNT = 20;
export const CACHEABLE_DEFAULT_SHAPES: ReadonlyArray<{
  count: number;
  excludeSourceTypes: string[];
}> = [
  { count: DEFAULT_LATEST_COUNT, excludeSourceTypes: [] },
  { count: HOMEPAGE_LATEST_COUNT, excludeSourceTypes: ["github"] },
];

// Escape hatch for shapes that don't fit `CACHEABLE_DEFAULT_SHAPES` — e.g.
// a single org-filtered key (`latest:v2:count=10&org=org_vercel_id`) where
// the org id is environment-specific and can't live in source. The shapes
// table is the preferred extension point; reach for the allowlist only
// when the cache key itself needs to encode runtime data. Empty by design —
// any addition must be paired with a matching purge entry below.
export const ALLOWLISTED_CACHE_KEYS: ReadonlySet<string> = new Set<string>();

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function isCacheableDefaultShape(p: NormalizedLatestParams): boolean {
  if (p.sourceId !== undefined || p.orgId !== undefined || p.includeCoverage) return false;
  // A time window is a filtered, low-cardinality-unfriendly shape — never let
  // it collide with the shared homepage/CLI key. (Matches the `tail -f`
  // rationale: windowed polling would otherwise fork the cache.)
  if (p.since !== undefined || p.until !== undefined) return false;
  return CACHEABLE_DEFAULT_SHAPES.some(
    (s) => s.count === p.count && arraysEqual(s.excludeSourceTypes, p.excludeSourceTypes),
  );
}

export function isCacheableLatestRequest(key: string, params: NormalizedLatestParams): boolean {
  return isCacheableDefaultShape(params) || ALLOWLISTED_CACHE_KEYS.has(key);
}

/** Build the cache key for one of the default cacheable shapes. */
function defaultShapeKey(shape: { count: number; excludeSourceTypes: string[] }): string {
  return buildLatestCacheKey({
    count: String(shape.count),
    exclude: shape.excludeSourceTypes.length > 0 ? shape.excludeSourceTypes.join(",") : undefined,
  });
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
  FLAGS?: FlagshipBinding;
}

/**
 * Purge every cached /v1/releases/latest default shape after a publish.
 *
 * Iterates `CACHEABLE_DEFAULT_SHAPES` so adding a new cacheable shape is a
 * one-line change and stays in sync automatically. Allowlisted shapes
 * (`ALLOWLISTED_CACHE_KEYS`) need a matching purge added here by hand.
 *
 * Called fire-and-forget from the publish sites alongside publishReleaseEvents.
 * Purges are best-effort; the 300s TTL remains the safety net on failure.
 *
 * Kept inline (no queue, no dedicated Worker) because the work is a small
 * fixed set of KV.delete()s in parallel. If a second event-driven side-
 * effect emerges, revisit a dedicated consumer — see issue #408.
 */
export async function invalidateLatestCache(
  env: InvalidationEnv,
  // `cause` is a free-form diagnostic tag for what triggered the purge — a
  // source id, an org id, or a literal like "cron". It's logged, never matched
  // on, so callers pass whatever identifies the trigger most usefully.
  meta: { nReleases: number; cause: string },
): Promise<void> {
  // REST shapes from CACHEABLE_DEFAULT_SHAPES + GraphQL homepage ticker
  // hash from the persisted-operations manifest. Invalidation is best-effort;
  // the 5-minute TTL is the safety net on either side.
  const keys = [...CACHEABLE_DEFAULT_SHAPES.map(defaultShapeKey), ...purgeKeysForHomepageTicker()];
  const logCtx = { cacheKeys: keys, cause: meta.cause, nReleases: meta.nReleases };

  if (!(await flag(env.FLAGS, env.INVALIDATION_ENABLED, FLAGS.invalidationEnabled))) {
    logEvent("info", {
      component: "invalidation",
      event: "skipped",
      reason: "flag_off",
      ...logCtx,
    });
    return;
  }
  if (!env.LATEST_CACHE) {
    logEvent("info", {
      component: "invalidation",
      event: "skipped",
      reason: "no_binding",
      ...logCtx,
    });
    return;
  }
  if (meta.nReleases <= 0) {
    logEvent("info", {
      component: "invalidation",
      event: "skipped",
      reason: "no_releases",
      ...logCtx,
    });
    return;
  }

  const cache = env.LATEST_CACHE;
  await Promise.all(
    keys.map(async (key) => {
      try {
        await cache.delete(key);
        logEvent("info", { component: "invalidation", event: "purged", cacheKey: key });
      } catch (err) {
        logEvent("warn", { component: "invalidation", event: "purge-failed", err, cacheKey: key });
      }
    }),
  );
}
