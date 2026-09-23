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
    expect(isCacheableFeedRequest(null, FEED_CACHE_PAGE_SIZE)).toBe(true);
    expect(isCacheableFeedRequest("2026-01-01T00:00:00Z|2026-01-01T00:00:00Z|rel_1", 30)).toBe(
      false,
    );
    expect(isCacheableFeedRequest(null, 50)).toBe(false);
  });
});
