import { describe, expect, it } from "bun:test";
import { buildEdgeCacheKey } from "../src/middleware/edge-cache.js";
import {
  CACHEABLE_DEFAULT_SHAPES,
  edgePurgeUrlForShape,
  purgeEdgeCacheUrls,
} from "../src/lib/latest-cache.js";

describe("buildEdgeCacheKey", () => {
  it("folds json vs markdown Accept into distinct cache keys", () => {
    const url = "https://api.releases.sh/v1/releases/latest?count=10";
    const jsonKey = buildEdgeCacheKey(url, "application/json").url;
    const mdKey = buildEdgeCacheKey(url, "text/markdown").url;
    expect(jsonKey).toContain("/__edgecache/json/v1/releases/latest");
    expect(mdKey).toContain("/__edgecache/md/v1/releases/latest");
    expect(jsonKey).not.toBe(mdKey);
  });

  it("sorts query params for stable keys", () => {
    const a = buildEdgeCacheKey(
      "https://api.releases.sh/v1/releases/latest?exclude=github&count=20",
      "application/json",
    ).url;
    const b = buildEdgeCacheKey(
      "https://api.releases.sh/v1/releases/latest?count=20&exclude=github",
      "application/json",
    ).url;
    expect(a).toBe(b);
  });
});

describe("edge purge URL shapes", () => {
  it("matches every CACHEABLE_DEFAULT_SHAPES entry", () => {
    for (const shape of CACHEABLE_DEFAULT_SHAPES) {
      const url = edgePurgeUrlForShape(shape);
      expect(url).toStartWith("https://api.releases.sh/v1/releases/latest?");
      expect(url).toContain(`count=${shape.count}`);
      if (shape.excludeSourceTypes.length > 0) {
        expect(url).toContain(`exclude=${shape.excludeSourceTypes.join(",")}`);
      }
    }
  });
});

describe("purgeEdgeCacheUrls", () => {
  it("fail-opens when caches is undefined", async () => {
    await expect(
      purgeEdgeCacheUrls([edgePurgeUrlForShape(CACHEABLE_DEFAULT_SHAPES[0]!)]),
    ).resolves.toBeUndefined();
  });
});
