import { describe, it, expect } from "bun:test";
import { makeReadCache, MCP_READ_CACHE_TTL_SECONDS } from "../src/lib/read-cache";
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
  async get(key: string, _type: "json"): Promise<unknown> {
    const v = this.store.get(key);
    return v === undefined ? null : JSON.parse(v);
  }
  async put(key: string, value: string): Promise<void> {
    this.puts += 1;
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

  it("exposes a short, conservative TTL (no publish-time invalidation)", () => {
    expect(MCP_READ_CACHE_TTL_SECONDS).toBeLessThanOrEqual(120);
    expect(MCP_READ_CACHE_TTL_SECONDS).toBeGreaterThan(0);
  });
});
