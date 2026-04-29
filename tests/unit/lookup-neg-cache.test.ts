import { describe, test, expect } from "bun:test";
import { readNegCache, writeNegCache } from "../../workers/api/src/lib/lookup-neg-cache.js";

interface FakeKv {
  store: Map<string, { value: string; expirationTtl?: number }>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

function makeKv(): FakeKv {
  const store = new Map<string, { value: string; expirationTtl?: number }>();
  return {
    store,
    async get(key) {
      return store.get(key)?.value ?? null;
    },
    async put(key, value, opts) {
      store.set(key, { value, expirationTtl: opts?.expirationTtl });
    },
  };
}

describe("lookup-neg-cache", () => {
  test("read returns null when nothing is cached", async () => {
    const kv = makeKv();
    const result = await readNegCache(kv as unknown as KVNamespace, "github", "acme/foo");
    expect(result).toBeNull();
  });

  test("write stores not_found with 24h TTL", async () => {
    const kv = makeKv();
    await writeNegCache(kv as unknown as KVNamespace, "github", "acme/foo", "not_found");
    const entry = kv.store.get("lookup:github:acme/foo");
    expect(entry).toBeDefined();
    expect(entry?.expirationTtl).toBe(24 * 60 * 60);
    expect(JSON.parse(entry!.value).status).toBe("not_found");
  });

  test("write stores empty with 6h TTL", async () => {
    const kv = makeKv();
    await writeNegCache(kv as unknown as KVNamespace, "github", "acme/foo", "empty");
    const entry = kv.store.get("lookup:github:acme/foo");
    expect(entry?.expirationTtl).toBe(6 * 60 * 60);
  });

  test("read parses a stored entry", async () => {
    const kv = makeKv();
    await writeNegCache(kv as unknown as KVNamespace, "github", "acme/foo", "not_found");
    const result = await readNegCache(kv as unknown as KVNamespace, "github", "acme/foo");
    expect(result?.status).toBe("not_found");
    expect(typeof result?.checkedAt).toBe("string");
  });

  test("read returns null on malformed JSON", async () => {
    const kv = makeKv();
    kv.store.set("lookup:github:acme/foo", { value: "not-json" });
    const result = await readNegCache(kv as unknown as KVNamespace, "github", "acme/foo");
    expect(result).toBeNull();
  });

  test("mixed-case write is readable as lowercase", async () => {
    const kv = makeKv();
    // Write with mixed-case coordinate (e.g. from user input "Acme/Foo").
    await writeNegCache(kv as unknown as KVNamespace, "github", "Acme/Foo", "not_found");
    // The stored key should be lowercase.
    expect(kv.store.has("lookup:github:acme/foo")).toBe(true);
    // Reading with either casing resolves the same entry.
    const resultLower = await readNegCache(kv as unknown as KVNamespace, "github", "acme/foo");
    expect(resultLower?.status).toBe("not_found");
    const resultMixed = await readNegCache(kv as unknown as KVNamespace, "github", "Acme/Foo");
    expect(resultMixed?.status).toBe("not_found");
  });
});
