import { describe, it, expect } from "bun:test";
import {
  buildLatestCacheKey,
  withLatestCache,
  LATEST_CACHE_TTL_SECONDS,
  type LatestCacheBinding,
} from "../../workers/api/src/lib/latest-cache.js";

interface PutCall {
  key: string;
  value: string;
  options?: { expirationTtl?: number };
}

function makeKv(initial: Record<string, unknown> = {}): {
  kv: LatestCacheBinding;
  gets: string[];
  puts: PutCall[];
  store: Map<string, string>;
} {
  const store = new Map<string, string>(
    Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]),
  );
  const gets: string[] = [];
  const puts: PutCall[] = [];
  return {
    store,
    gets,
    puts,
    kv: {
      async get(key, _type) {
        gets.push(key);
        const raw = store.get(key);
        return raw === undefined ? null : JSON.parse(raw);
      },
      async put(key, value, options) {
        puts.push({ key, value, options });
        store.set(key, value);
      },
    },
  };
}

describe("buildLatestCacheKey", () => {
  it("sorts params so ordering doesn't fork cache entries", () => {
    const a = buildLatestCacheKey({ count: "10", source: "src_a", include_coverage: "true" });
    const b = buildLatestCacheKey({ include_coverage: "true", source: "src_a", count: "10" });
    expect(a).toBe(b);
  });

  it("omits undefined and empty-string params", () => {
    const k = buildLatestCacheKey({
      count: "10",
      source: undefined,
      org: "",
      include_coverage: undefined,
    });
    expect(k).toBe("latest:v1:count=10");
  });

  it("uses the v1 prefix so a shape bump can flush the keyspace", () => {
    expect(buildLatestCacheKey({ count: "10" })).toMatch(/^latest:v1:/);
  });

  it("returns the prefix alone when no params are present", () => {
    expect(buildLatestCacheKey({})).toBe("latest:v1:");
  });
});

describe("LATEST_CACHE_TTL_SECONDS", () => {
  // Pins the TTL so an accidental regression is caught — write volume on the
  // KV namespace scales inversely with this value. See issue #333.
  it("is 300 seconds", () => {
    expect(LATEST_CACHE_TTL_SECONDS).toBe(300);
  });
});

describe("withLatestCache", () => {
  it("is pass-through when kv is undefined", async () => {
    let calls = 0;
    const compute = async () => {
      calls++;
      return [{ id: "rel_1" }];
    };
    const first = await withLatestCache(undefined, "key", undefined, compute);
    const second = await withLatestCache(undefined, "key", undefined, compute);
    expect(calls).toBe(2);
    expect(first.hit).toBe(false);
    expect(second.hit).toBe(false);
    expect(second.data).toEqual([{ id: "rel_1" }]);
  });

  it("serves the cached value on hit and skips compute", async () => {
    const { kv, puts } = makeKv();
    let calls = 0;
    const compute = async () => {
      calls++;
      return [{ id: "rel_1" }];
    };

    const miss = await withLatestCache(kv, "k", undefined, compute);
    const hit = await withLatestCache(kv, "k", undefined, compute);

    expect(calls).toBe(1);
    expect(miss.hit).toBe(false);
    expect(hit.hit).toBe(true);
    expect(hit.data).toEqual(miss.data);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.options?.expirationTtl).toBe(LATEST_CACHE_TTL_SECONDS);
  });

  it("falls through to compute when KV get throws", async () => {
    const kv: LatestCacheBinding = {
      async get() {
        throw new Error("KV down");
      },
      async put() {},
    };
    let calls = 0;
    const result = await withLatestCache(kv, "k", undefined, async () => {
      calls++;
      return "ok";
    });
    expect(calls).toBe(1);
    expect(result.data).toBe("ok");
    expect(result.hit).toBe(false);
  });

  it("swallows KV put errors — a failed write never fails the request", async () => {
    const kv: LatestCacheBinding = {
      async get() {
        return null;
      },
      async put() {
        throw new Error("KV write failed");
      },
    };
    const result = await withLatestCache(kv, "k", undefined, async () => "ok");
    expect(result.data).toBe("ok");
  });

  it("hands writes to waitUntil when provided so the response isn't blocked", async () => {
    let resolvePut: (() => void) | undefined;
    const blockingPut = new Promise<void>((r) => {
      resolvePut = r;
    });
    const kv: LatestCacheBinding = {
      async get() {
        return null;
      },
      async put() {
        await blockingPut;
      },
    };
    const captured: Promise<unknown>[] = [];
    const waitUntil = (p: Promise<unknown>) => {
      captured.push(p);
    };

    const result = await withLatestCache(kv, "k", waitUntil, async () => "ok");
    expect(result.data).toBe("ok");
    expect(captured).toHaveLength(1);
    resolvePut?.();
    await captured[0];
  });
});
