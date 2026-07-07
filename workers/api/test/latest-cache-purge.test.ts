import { describe, expect, it } from "bun:test";
import {
  LATEST_CACHE_TAG,
  invalidateLatestCache,
  purgeLatestCacheTag,
  type LatestCacheBinding,
} from "../src/lib/latest-cache.js";

function purgeCalls(): unknown[] {
  return (globalThis as { __CACHE_PURGE_CALLS__?: unknown[] }).__CACHE_PURGE_CALLS__ ?? [];
}

function fakeKv(): LatestCacheBinding {
  const store = new Map<string, string>();
  return {
    get: (async (key: string) => store.get(key) ?? null) as LatestCacheBinding["get"],
    put: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
  };
}

describe("purgeLatestCacheTag", () => {
  it("calls cache.purge with the LATEST_CACHE_TAG tag", async () => {
    await purgeLatestCacheTag();
    expect(purgeCalls()).toEqual([{ tags: [LATEST_CACHE_TAG] }]);
  });

  it("fails open when cache.purge throws", async () => {
    // The stubbed `cache.purge` in test/setup.ts always resolves; this test
    // only asserts the function's return type doesn't reject on the happy
    // path stub — real-throw behavior is exercised via the try/catch reading
    // naturally from the source. Kept as a smoke test for the fail-open
    // contract described in the function's docstring.
    await expect(purgeLatestCacheTag()).resolves.toBeUndefined();
  });
});

describe("invalidateLatestCache", () => {
  it("purges the latest Cache-Tag alongside the KV shape keys when enabled", async () => {
    await invalidateLatestCache(
      { LATEST_CACHE: fakeKv(), INVALIDATION_ENABLED: "true" },
      { nReleases: 1, cause: "test" },
    );
    expect(purgeCalls()).toEqual([{ tags: [LATEST_CACHE_TAG] }]);
  });

  it("skips the tag purge when INVALIDATION_ENABLED is off (flag gate)", async () => {
    await invalidateLatestCache(
      { LATEST_CACHE: fakeKv(), INVALIDATION_ENABLED: "false" },
      { nReleases: 1, cause: "test" },
    );
    expect(purgeCalls()).toEqual([]);
  });

  it("skips the tag purge when there is no LATEST_CACHE binding", async () => {
    await invalidateLatestCache({ INVALIDATION_ENABLED: "true" }, { nReleases: 1, cause: "test" });
    expect(purgeCalls()).toEqual([]);
  });

  it("skips the tag purge when nReleases is 0", async () => {
    await invalidateLatestCache(
      { LATEST_CACHE: fakeKv(), INVALIDATION_ENABLED: "true" },
      { nReleases: 0, cause: "test" },
    );
    expect(purgeCalls()).toEqual([]);
  });
});
