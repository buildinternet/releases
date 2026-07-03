import { describe, it, expect } from "bun:test";
import {
  makeReadCache,
  makeSearchReadCache,
  MCP_READ_CACHE_TTL_SECONDS,
  searchParamsCacheable,
} from "../src/lib/read-cache";
import type { SearchToolReturn } from "../src/tools";
import type { ToolResult } from "../src/tools";

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

class FakeKV {
  store = new Map<string, string>();
  puts = 0;
  lastPutOptions?: { expirationTtl?: number };
  /** When true, get/put reject — exercises the fail-open path. */
  throwOnOp = false;
  async get(key: string, _type: "json"): Promise<unknown> {
    if (this.throwOnOp) throw new Error("kv get failed");
    const v = this.store.get(key);
    return v === undefined ? null : JSON.parse(v);
  }
  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    if (this.throwOnOp) throw new Error("kv put failed");
    this.puts += 1;
    this.lastPutOptions = options;
    this.store.set(key, value);
  }
}

describe("makeReadCache", () => {
  it("returns the handler unchanged when no KV binding is present (fail-open)", async () => {
    const cached = makeReadCache(undefined);
    let calls = 0;
    const handler = cached("get_organization", async () => {
      calls += 1;
      return ok("live");
    });
    expect((await handler({ identifier: "vercel" })).content[0].text).toBe("live");
    expect((await handler({ identifier: "vercel" })).content[0].text).toBe("live");
    expect(calls).toBe(2); // no caching without a binding
  });

  it("serves the second identical call from cache without re-running the handler", async () => {
    const kv = new FakeKV();
    const cached = makeReadCache(kv);
    let calls = 0;
    const handler = cached("get_latest_releases", async () => {
      calls += 1;
      return ok(`run ${calls}`);
    });
    expect((await handler({ count: 10 })).content[0].text).toBe("run 1");
    expect((await handler({ count: 10 })).content[0].text).toBe("run 1"); // HIT
    expect(calls).toBe(1);
    // The write set the expiry to the module TTL (and ≥ KV's 60s minimum).
    expect(kv.lastPutOptions?.expirationTtl).toBe(MCP_READ_CACHE_TTL_SECONDS);
    expect(kv.lastPutOptions?.expirationTtl ?? 0).toBeGreaterThanOrEqual(60);
  });

  it("keys on params and tool name — different params miss independently", async () => {
    const kv = new FakeKV();
    const cached = makeReadCache(kv);
    let calls = 0;
    const handler = cached("list_catalog", async () => {
      calls += 1;
      return ok(`run ${calls}`);
    });
    await handler({ page: 1 });
    await handler({ page: 2 });
    await handler({ page: 1 }); // HIT
    expect(calls).toBe(2);
  });

  it("is order-independent in the param object (stable key)", async () => {
    const kv = new FakeKV();
    const cached = makeReadCache(kv);
    let calls = 0;
    const handler = cached("lookup_domain", async () => {
      calls += 1;
      return ok("x");
    });
    await handler({ a: 1, b: 2 } as Record<string, number>);
    await handler({ b: 2, a: 1 } as Record<string, number>); // same key → HIT
    expect(calls).toBe(1);
  });

  it("never caches a tool-level failure", async () => {
    const kv = new FakeKV();
    const cached = makeReadCache(kv);
    let calls = 0;
    const handler = cached("get_organization", async () => {
      calls += 1;
      return fail("not found");
    });
    await handler({ identifier: "nope" });
    await handler({ identifier: "nope" }); // not cached → runs again
    expect(calls).toBe(2);
    expect(kv.puts).toBe(0);
  });

  it("fails open when a present KV binding throws (get/put errors don't propagate)", async () => {
    const kv = new FakeKV();
    kv.throwOnOp = true;
    const cached = makeReadCache(kv);
    let calls = 0;
    const handler = cached("get_organization", async () => {
      calls += 1;
      return ok("live");
    });
    // get() throws → falls through to the handler; put() throws → swallowed.
    expect((await handler({ identifier: "vercel" })).content[0].text).toBe("live");
    expect((await handler({ identifier: "vercel" })).content[0].text).toBe("live");
    expect(calls).toBe(2);
  });

  it("caches get_release on identical params", async () => {
    const kv = new FakeKV();
    const cached = makeReadCache(kv);
    let calls = 0;
    const handler = cached("get_release", async () => {
      calls += 1;
      return ok(`rel ${calls}`);
    });
    await handler({ id: "rel_abc" });
    await handler({ id: "rel_abc" });
    expect(calls).toBe(1);
    expect(kv.puts).toBe(1);
  });

  it("bypasses search cache for relative since/until bounds", async () => {
    const kv = new FakeKV();
    const cachedSearch = makeSearchReadCache(kv);
    let calls = 0;
    const handler = cachedSearch(async (): Promise<SearchToolReturn> => {
      calls += 1;
      return { result: ok(`q ${calls}`), counts: {} };
    });
    await handler({ query: "bun", since: "90d" });
    await handler({ query: "bun", since: "90d" });
    expect(calls).toBe(2);
    expect(kv.puts).toBe(0);
  });

  it("caches search when date bounds are cacheable", async () => {
    const kv = new FakeKV();
    const cachedSearch = makeSearchReadCache(kv);
    let calls = 0;
    const handler = cachedSearch(async (): Promise<SearchToolReturn> => {
      calls += 1;
      return { result: ok(`q ${calls}`), counts: { releaseHits: 1 } };
    });
    await handler({ query: "bun" });
    await handler({ query: "bun" });
    expect(calls).toBe(1);
    expect(kv.puts).toBe(1);
  });

  it("searchParamsCacheable allows ISO bounds and absent dates", () => {
    expect(searchParamsCacheable({})).toBe(true);
    expect(searchParamsCacheable({ since: "2026-01-01" })).toBe(true);
    expect(searchParamsCacheable({ since: "90d" })).toBe(false);
    expect(searchParamsCacheable({ until: "4w" })).toBe(false);
  });

  it("exposes a short, conservative TTL within KV's bounds (≥ 60s minimum)", () => {
    // Cloudflare KV rejects expirationTtl below 60s, so the constant must never
    // dip under that floor; the upper bound keeps staleness short (no purge).
    expect(MCP_READ_CACHE_TTL_SECONDS).toBeGreaterThanOrEqual(60);
    expect(MCP_READ_CACHE_TTL_SECONDS).toBeLessThanOrEqual(120);
  });
});
