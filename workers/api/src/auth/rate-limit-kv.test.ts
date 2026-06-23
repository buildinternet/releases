import { describe, it, expect } from "bun:test";
import {
  kvRateLimitStorage,
  AUTH_RATE_LIMIT_KV_TTL_SECONDS,
  type RateLimitRecord,
} from "./rate-limit-kv.js";

/** Minimal in-memory stand-in for the KV binding, capturing put options. */
function fakeKv() {
  const store = new Map<string, string>();
  const puts: Array<{ key: string; value: string; options?: { expirationTtl?: number } }> = [];
  return {
    puts,
    store,
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      store.set(key, value);
      puts.push({ key, value, options });
    },
  };
}

describe("kvRateLimitStorage", () => {
  const record: RateLimitRecord = { key: "1.2.3.4/sign-in/email", count: 2, lastRequest: 1000 };

  it("returns null for an absent key", async () => {
    const storage = kvRateLimitStorage(fakeKv());
    expect(await storage.get("missing")).toBeNull();
  });

  it("round-trips a record through set → get", async () => {
    const storage = kvRateLimitStorage(fakeKv());
    await storage.set(record.key, record);
    expect(await storage.get(record.key)).toEqual(record);
  });

  it("writes with the fixed TTL (not an update flag)", async () => {
    const kv = fakeKv();
    const storage = kvRateLimitStorage(kv);
    // Better Auth passes `update` as the third arg; it must NOT leak into the TTL.
    await storage.set(record.key, record, true);
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0].options?.expirationTtl).toBe(AUTH_RATE_LIMIT_KV_TTL_SECONDS);
  });

  it("reads a stored value back under its own key (no key mixing)", async () => {
    const kv = fakeKv();
    const storage = kvRateLimitStorage(kv);
    await storage.set("a", { key: "a", count: 1, lastRequest: 5 });
    await storage.set("b", { key: "b", count: 9, lastRequest: 7 });
    expect(await storage.get("a")).toEqual({ key: "a", count: 1, lastRequest: 5 });
    expect(await storage.get("b")).toEqual({ key: "b", count: 9, lastRequest: 7 });
  });

  it("fails open to null on malformed JSON", async () => {
    const kv = fakeKv();
    kv.store.set("k", "{not valid json");
    const storage = kvRateLimitStorage(kv);
    expect(await storage.get("k")).toBeNull();
  });

  it("fails open to null on a wrong-shape value", async () => {
    const kv = fakeKv();
    kv.store.set("k", JSON.stringify({ count: "nope" }));
    const storage = kvRateLimitStorage(kv);
    expect(await storage.get("k")).toBeNull();
  });

  it("keeps the TTL above KV's 60s minimum and the 60s default window", async () => {
    expect(AUTH_RATE_LIMIT_KV_TTL_SECONDS).toBeGreaterThanOrEqual(60);
  });
});
