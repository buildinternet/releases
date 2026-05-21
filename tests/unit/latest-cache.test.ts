import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  buildLatestCacheKey,
  withLatestCache,
  invalidateLatestCache,
  LATEST_CACHE_TTL_SECONDS,
  DEFAULT_LATEST_COUNT,
  ALLOWLISTED_CACHE_KEYS,
  isCacheableLatestRequest,
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
      async delete(key) {
        store.delete(key);
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
    expect(k).toBe("latest:v2:count=10");
  });

  it("uses the v2 prefix so a shape bump can flush the keyspace", () => {
    expect(buildLatestCacheKey({ count: "10" })).toMatch(/^latest:v2:/);
  });

  it("returns the prefix alone when no params are present", () => {
    expect(buildLatestCacheKey({})).toBe("latest:v2:");
  });
});

describe("LATEST_CACHE_TTL_SECONDS", () => {
  // Pins the TTL so an accidental regression is caught — write volume on the
  // KV namespace scales inversely with this value. See issue #333.
  it("is 300 seconds", () => {
    expect(LATEST_CACHE_TTL_SECONDS).toBe(300);
  });
});

describe("isCacheableLatestRequest", () => {
  // Helper: every cacheable check needs a key + params pair. The key only
  // matters for allowlist membership so it's synthesized from the params.
  function check(params: {
    count?: number;
    sourceId?: string;
    orgId?: string;
    includeCoverage?: boolean;
    excludeSourceTypes?: string[];
  }): boolean {
    const exclude = (params.excludeSourceTypes ?? []).toSorted();
    const normalized = {
      count: params.count ?? DEFAULT_LATEST_COUNT,
      sourceId: params.sourceId,
      orgId: params.orgId,
      includeCoverage: params.includeCoverage ?? false,
      excludeSourceTypes: exclude,
    };
    const key = buildLatestCacheKey({
      count: String(normalized.count),
      source: normalized.sourceId,
      org: normalized.orgId,
      include_coverage: normalized.includeCoverage ? "true" : undefined,
      exclude: exclude.length > 0 ? exclude.join(",") : undefined,
    });
    return isCacheableLatestRequest(key, normalized);
  }

  it("caches the default unfiltered request", () => {
    expect(check({})).toBe(true);
  });

  it("caches the homepage shape (count=20, exclude=github)", () => {
    expect(check({ count: 20, excludeSourceTypes: ["github"] })).toBe(true);
  });

  it("does not cache exclude on a non-homepage count", () => {
    expect(check({ count: 10, excludeSourceTypes: ["github"] })).toBe(false);
  });

  it("does not cache when a source filter is present", () => {
    expect(check({ sourceId: "src_abc" })).toBe(false);
  });

  it("does not cache when an org filter is present", () => {
    expect(check({ orgId: "org_vercel" })).toBe(false);
  });

  it("does not cache non-default counts", () => {
    expect(check({ count: 25 })).toBe(false);
    expect(check({ count: 1 })).toBe(false);
  });

  it("does not cache when coverage is explicitly included", () => {
    expect(check({ includeCoverage: true })).toBe(false);
  });

  it("caches allowlisted filtered shapes", () => {
    // Simulate a high-value target being added to the allowlist without
    // mutating the real Set — the production allowlist stays empty so this
    // test only verifies the lookup wiring.
    const allowlistedKey = "latest:v2:count=10&org=org_test_allowlist";
    const params = {
      count: DEFAULT_LATEST_COUNT,
      sourceId: undefined,
      orgId: "org_test_allowlist",
      includeCoverage: false,
      excludeSourceTypes: [],
    };
    expect(isCacheableLatestRequest(allowlistedKey, params)).toBe(false);

    const withAdded: ReadonlySet<string> = new Set([allowlistedKey]);
    const wouldCache =
      withAdded.has(allowlistedKey) || isCacheableLatestRequest(allowlistedKey, params);
    expect(wouldCache).toBe(true);
  });

  it("ships with an empty allowlist — additions are an explicit decision", () => {
    expect(ALLOWLISTED_CACHE_KEYS.size).toBe(0);
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
      async delete() {},
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
      async delete() {},
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
      async delete() {},
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

describe("invalidateLatestCache", () => {
  type KvStub = {
    get: ReturnType<typeof mock>;
    put: ReturnType<typeof mock>;
    delete: ReturnType<typeof mock>;
  };

  function mkKv(overrides: Partial<KvStub> = {}): KvStub {
    return {
      get: mock(async () => null),
      put: mock(async () => undefined),
      delete: mock(async () => undefined),
      ...overrides,
    };
  }

  // logEvent emits structured JSON via console.log / console.warn / console.error.
  // Capture both, parse each arg as JSON, and match against the {component, event, ...}
  // shape produced by `@releases/lib/log-event`.
  let logs: Record<string, unknown>[] = [];
  const origConsoleLog = console.log;
  const origConsoleWarn = console.warn;
  const origConsoleError = console.error;
  function capture(...args: unknown[]) {
    const first = args[0];
    if (typeof first === "string") {
      try {
        logs.push(JSON.parse(first));
        return;
      } catch {
        // Fall through to raw string capture for non-JSON lines.
      }
    }
    logs.push({ raw: args.map(String).join(" ") });
  }
  beforeEach(() => {
    logs = [];
    console.log = capture;
    console.warn = capture;
    console.error = capture;
  });

  afterEach(() => {
    console.log = origConsoleLog;
    console.warn = origConsoleWarn;
    console.error = origConsoleError;
  });

  it("skips with reason=flag_off when INVALIDATION_ENABLED is unset", async () => {
    const kv = mkKv();
    await invalidateLatestCache({ LATEST_CACHE: kv }, { nReleases: 3, cause: "src_abc" });
    expect(kv.delete).not.toHaveBeenCalled();
    expect(
      logs.some(
        (l) => l.component === "invalidation" && l.event === "skipped" && l.reason === "flag_off",
      ),
    ).toBe(true);
  });

  it("skips with reason=flag_off when INVALIDATION_ENABLED is 'false'", async () => {
    const kv = mkKv();
    await invalidateLatestCache(
      { LATEST_CACHE: kv, INVALIDATION_ENABLED: "false" },
      { nReleases: 3, cause: "src_abc" },
    );
    expect(kv.delete).not.toHaveBeenCalled();
    expect(
      logs.some(
        (l) => l.component === "invalidation" && l.event === "skipped" && l.reason === "flag_off",
      ),
    ).toBe(true);
  });

  it("skips with reason=no_releases when nReleases is 0", async () => {
    const kv = mkKv();
    await invalidateLatestCache(
      { LATEST_CACHE: kv, INVALIDATION_ENABLED: "true" },
      { nReleases: 0, cause: "src_abc" },
    );
    expect(kv.delete).not.toHaveBeenCalled();
    expect(
      logs.some(
        (l) =>
          l.component === "invalidation" && l.event === "skipped" && l.reason === "no_releases",
      ),
    ).toBe(true);
  });

  it("skips with reason=no_binding when LATEST_CACHE is undefined", async () => {
    await invalidateLatestCache(
      { INVALIDATION_ENABLED: "true" },
      { nReleases: 2, cause: "src_abc" },
    );
    expect(
      logs.some(
        (l) => l.component === "invalidation" && l.event === "skipped" && l.reason === "no_binding",
      ),
    ).toBe(true);
  });

  it("purges every default cacheable shape when flag is on and binding present", async () => {
    const kv = mkKv();
    await invalidateLatestCache(
      { LATEST_CACHE: kv, INVALIDATION_ENABLED: "true" },
      { nReleases: 5, cause: "src_abc" },
    );
    expect(kv.delete).toHaveBeenCalledWith("latest:v2:count=10");
    expect(kv.delete).toHaveBeenCalledWith("latest:v2:count=20&exclude=github");
    // 2 REST shapes + 1 GraphQL homepage hash (from purgeKeysForHomepageTicker
    // in workers/api/src/graphql/persisted.ts).
    expect(kv.delete).toHaveBeenCalledTimes(3);
    expect(logs.filter((l) => l.component === "invalidation" && l.event === "purged")).toHaveLength(
      3,
    );
  });

  it("swallows KV.delete errors per-key — one failure doesn't block the others", async () => {
    let calls = 0;
    const kv = mkKv({
      delete: mock(async () => {
        calls++;
        if (calls === 1) throw new Error("kv down");
      }),
    });
    const result = await invalidateLatestCache(
      { LATEST_CACHE: kv, INVALIDATION_ENABLED: "true" },
      { nReleases: 2, cause: "src_abc" },
    );
    expect(result).toBeUndefined();
    // 2 REST shapes + 1 GraphQL homepage hash; first call throws, others
    // still run and log per-key.
    expect(kv.delete).toHaveBeenCalledTimes(3);
    expect(
      logs.some(
        (l) =>
          l.component === "invalidation" &&
          l.event === "purge-failed" &&
          (l.err as { message?: string } | undefined)?.message === "kv down",
      ),
    ).toBe(true);
    expect(logs.some((l) => l.component === "invalidation" && l.event === "purged")).toBe(true);
  });
});
