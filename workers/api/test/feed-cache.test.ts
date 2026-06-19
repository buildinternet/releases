import { describe, expect, it } from "bun:test";
import {
  buildFeedCacheKey,
  FEED_CACHE_PAGE_SIZE,
  isCacheableFeedRequest,
} from "../src/lib/feed-cache.js";

describe("feed-cache", () => {
  it("builds a per-user key", () => {
    expect(buildFeedCacheKey("usr_1")).toBe("feed:v1:usr_1");
  });

  it("caches only the default first page", () => {
    expect(isCacheableFeedRequest({ page: 1, pageSize: FEED_CACHE_PAGE_SIZE, offset: 0 })).toBe(
      true,
    );
    expect(isCacheableFeedRequest({ page: 2, pageSize: FEED_CACHE_PAGE_SIZE, offset: 30 })).toBe(
      false,
    );
    expect(isCacheableFeedRequest({ page: 1, pageSize: 50, offset: 0 })).toBe(false);
  });
});
