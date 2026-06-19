/**
 * KV key helpers for GET /v1/me/feed (page 1, default page size only).
 * Reuses LATEST_CACHE + `withLatestCache` from latest-cache.ts.
 */

import type { LatestCacheBinding } from "./latest-cache.js";
import type { ListPaginationParams } from "./pagination.js";

/** Personalized feeds should feel fresh; shorter than the global latest cache. */
export const FEED_CACHE_TTL_SECONDS = 90;

/** Must match `defaultPageSize` on GET /v1/me/feed and the web feed client. */
export const FEED_CACHE_PAGE_SIZE = 30;

const KEY_PREFIX = "feed:v1";

export function buildFeedCacheKey(userId: string): string {
  return `${KEY_PREFIX}:${userId}`;
}

export function isCacheableFeedRequest(pagination: ListPaginationParams): boolean {
  return (
    pagination.page === 1 && pagination.pageSize === FEED_CACHE_PAGE_SIZE && pagination.offset === 0
  );
}

export async function invalidateUserFeedCache(
  kv: LatestCacheBinding | undefined,
  userId: string,
): Promise<void> {
  if (!kv) return;
  await kv.delete(buildFeedCacheKey(userId)).catch(() => {});
}
