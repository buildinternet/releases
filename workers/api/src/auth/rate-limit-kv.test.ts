import { describe, it, expect } from "bun:test";
import {
  kvRateLimitStorage,
  readRecord,
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

const KEY = "1.2.3.4/sign-in/email";
const RULE = { window: 10, max: 3 };

function stored(kv: ReturnType<typeof fakeKv>, key: string): RateLimitRecord {
  return JSON.parse(kv.store.get(key) as string) as RateLimitRecord;
}

describe("readRecord", () => {
  it("returns null for an absent key", async () => {
    expect(await readRecord(fakeKv(), "missing")).toBeNull();
  });

  it("fails open to null on malformed JSON", async () => {
    const kv = fakeKv();
    kv.store.set("k", "{not valid json");
    expect(await readRecord(kv, "k")).toBeNull();
  });

  it("fails open to null on a wrong-shape value", async () => {
    const kv = fakeKv();
    kv.store.set("k", JSON.stringify({ count: "nope" }));
    expect(await readRecord(kv, "k")).toBeNull();
  });
});

describe("kvRateLimitStorage.consume", () => {
  it("allows and seeds a fresh window on the first request", async () => {
    const kv = fakeKv();
    const storage = kvRateLimitStorage(kv);
    expect(await storage.consume(KEY, RULE)).toEqual({ allowed: true, retryAfter: null });
    expect(stored(kv, KEY).count).toBe(1);
  });

  it("increments up to max, then rejects with a retryAfter", async () => {
    const storage = kvRateLimitStorage(fakeKv());
    for (let i = 0; i < RULE.max; i++) {
      expect((await storage.consume(KEY, RULE)).allowed).toBe(true);
    }
    const denied = await storage.consume(KEY, RULE);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfter).toBeGreaterThan(0);
    expect(denied.retryAfter).toBeLessThanOrEqual(RULE.window);
  });

  it("does not advance lastRequest on a rejected attempt (window is not extended)", async () => {
    const kv = fakeKv();
    const storage = kvRateLimitStorage(kv);
    for (let i = 0; i < RULE.max; i++) await storage.consume(KEY, RULE);
    const before = stored(kv, KEY);
    await storage.consume(KEY, RULE);
    expect(stored(kv, KEY)).toEqual(before);
  });

  it("resets the counter once the rolling window has elapsed", async () => {
    const kv = fakeKv();
    const storage = kvRateLimitStorage(kv);
    for (let i = 0; i < RULE.max; i++) await storage.consume(KEY, RULE);
    expect((await storage.consume(KEY, RULE)).allowed).toBe(false);
    // Backdate the stored record past the window.
    const rec = stored(kv, KEY);
    kv.store.set(
      KEY,
      JSON.stringify({ ...rec, lastRequest: rec.lastRequest - RULE.window * 1000 }),
    );
    expect(await storage.consume(KEY, RULE)).toEqual({ allowed: true, retryAfter: null });
    expect(stored(kv, KEY).count).toBe(1);
  });

  it("counts each key independently (no key mixing)", async () => {
    const kv = fakeKv();
    const storage = kvRateLimitStorage(kv);
    await storage.consume("a", RULE);
    await storage.consume("a", RULE);
    await storage.consume("b", RULE);
    expect(stored(kv, "a").count).toBe(2);
    expect(stored(kv, "b").count).toBe(1);
  });

  it("writes with the floor TTL for windows shorter than it", async () => {
    const kv = fakeKv();
    await kvRateLimitStorage(kv).consume(KEY, RULE);
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0].options?.expirationTtl).toBe(AUTH_RATE_LIMIT_KV_TTL_SECONDS);
  });

  it("stretches the TTL to cover a window longer than the floor", async () => {
    const kv = fakeKv();
    const window = AUTH_RATE_LIMIT_KV_TTL_SECONDS + 90.5;
    await kvRateLimitStorage(kv).consume(KEY, { window, max: 3 });
    expect(kv.puts[0].options?.expirationTtl).toBe(Math.ceil(window));
  });

  it("keeps the TTL above KV's 60s minimum and the 60s default window", () => {
    expect(AUTH_RATE_LIMIT_KV_TTL_SECONDS).toBeGreaterThanOrEqual(60);
  });
});
