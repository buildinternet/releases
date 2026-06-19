/**
 * KV key helpers for GET /v1/me/feed (first page, default limit only).
 * Reuses LATEST_CACHE + `withLatestCache` from latest-cache.ts.
 */

import type { LatestCacheBinding } from "./latest-cache.js";

/** Personalized feeds should feel fresh; shorter than the global latest cache. */
export const FEED_CACHE_TTL_SECONDS = 90;

/** Must match the default `?limit=` on GET /v1/me/feed and the web feed client. */
export const FEED_CACHE_PAGE_SIZE = 30;

const KEY_PREFIX = "feed:v1";

export function buildFeedCacheKey(userId: string): string {
  return `${KEY_PREFIX}:${userId}`;
}

/** Cache only the default first slice — no cursor, default limit. */
export function isCacheableFeedRequest(cursor: string | null, limit: number): boolean {
  return !cursor && limit === FEED_CACHE_PAGE_SIZE;
}

export async function invalidateUserFeedCache(
  kv: LatestCacheBinding | undefined,
  userId: string,
): Promise<void> {
  if (!kv) return;
  await kv.delete(buildFeedCacheKey(userId)).catch(() => {});
}
