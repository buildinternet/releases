import { describe, it, expect } from "bun:test";
import {
  withEmbedCache,
  EMBED_CACHE_TTL_SECONDS,
  type EmbedCacheBinding,
} from "@releases/search/embedding-cache";

interface PutCall {
  key: string;
  value: string;
  options?: { expirationTtl?: number };
}

function makeKv(initial: Record<string, unknown> = {}): {
  kv: EmbedCacheBinding;
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

function vector(n: number, seed = 0): number[] {
  return Array.from({ length: n }, (_, i) => (i + seed) / n);
}

const VOYAGE = { provider: "voyage", model: "voyage-4-lite", dim: 8 } as const;

describe("withEmbedCache", () => {
  it("returns the unwrapped embedder when kv is undefined", async () => {
    let calls = 0;
    const embed = async () => {
      calls++;
      return vector(8);
    };
    const wrapped = withEmbedCache(embed, undefined, VOYAGE);
    await wrapped("next.js");
    await wrapped("next.js");
    expect(calls).toBe(2);
  });

  it("caches misses and serves hits without re-embedding", async () => {
    const { kv, puts } = makeKv();
    let calls = 0;
    const embed = async () => {
      calls++;
      return vector(8, calls);
    };
    const wrapped = withEmbedCache(embed, kv, VOYAGE);

    const first = await wrapped("next.js");
    const second = await wrapped("next.js");

    expect(calls).toBe(1);
    expect(second).toEqual(first);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.options?.expirationTtl).toBe(EMBED_CACHE_TTL_SECONDS);
  });

  it("normalizes query (trim + lowercase) before keying", async () => {
    const { kv, puts } = makeKv();
    let calls = 0;
    const embed = async () => {
      calls++;
      return vector(8);
    };
    const wrapped = withEmbedCache(embed, kv, VOYAGE);

    await wrapped("Next.JS");
    await wrapped("  next.js  ");
    await wrapped("next.js");

    expect(calls).toBe(1);
    expect(puts).toHaveLength(1);
  });

  it("includes provider / model / dim in the key", async () => {
    const { kv, puts } = makeKv();
    const embed = async () => vector(8);
    const voyageWrapped = withEmbedCache(embed, kv, VOYAGE);
    const openaiWrapped = withEmbedCache(embed, kv, {
      provider: "openai",
      model: "text-embedding-3-small",
      dim: 8,
    } as const);

    await voyageWrapped("next.js");
    await openaiWrapped("next.js");

    expect(puts).toHaveLength(2);
    expect(puts[0]!.key).not.toBe(puts[1]!.key);
    expect(puts[0]!.key).toContain(":voyage:");
    expect(puts[1]!.key).toContain(":openai:");
  });

  it("re-embeds when the stored vector has the wrong dimensionality", async () => {
    const { kv, puts } = makeKv();
    let calls = 0;
    const embed = async () => {
      calls++;
      return vector(8);
    };
    const wrapped = withEmbedCache(embed, kv, VOYAGE);

    await wrapped("test");
    expect(calls).toBe(1);

    // Poison the cached entry with the wrong dim.
    const key = puts[0]!.key;
    await kv.put(key, JSON.stringify(vector(4)));

    await wrapped("test");
    expect(calls).toBe(2);
  });

  it("skips the cache for empty or too-long queries", async () => {
    const { kv, puts, gets } = makeKv();
    let calls = 0;
    const embed = async () => {
      calls++;
      return vector(8);
    };
    const wrapped = withEmbedCache(embed, kv, VOYAGE);

    await wrapped("");
    await wrapped("   ");
    await wrapped("a".repeat(513));

    expect(calls).toBe(3);
    expect(gets).toHaveLength(0);
    expect(puts).toHaveLength(0);
  });

  it("falls through to the embedder when KV get throws", async () => {
    const kv: EmbedCacheBinding = {
      async get() {
        throw new Error("KV down");
      },
      async put() {},
    };
    let calls = 0;
    const embed = async () => {
      calls++;
      return vector(8);
    };
    const wrapped = withEmbedCache(embed, kv, VOYAGE);
    const result = await wrapped("next.js");
    expect(calls).toBe(1);
    expect(result).toHaveLength(8);
  });

  it("swallows KV put errors — a failed write never fails the call", async () => {
    const kv: EmbedCacheBinding = {
      async get() {
        return null;
      },
      async put() {
        throw new Error("KV write failed");
      },
    };
    const embed = async () => vector(8);
    const wrapped = withEmbedCache(embed, kv, VOYAGE);
    const result = await wrapped("next.js");
    expect(result).toHaveLength(8);
  });

  it("hands writes to waitUntil when provided (no blocking)", async () => {
    let resolvePut: (() => void) | undefined;
    const blockingPut = new Promise<void>((r) => {
      resolvePut = r;
    });
    const kv: EmbedCacheBinding = {
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
    const embed = async () => vector(8);
    const wrapped = withEmbedCache(embed, kv, VOYAGE, waitUntil);

    // If the wrapper awaited the put, this would hang forever.
    const result = await wrapped("next.js");
    expect(result).toHaveLength(8);
    expect(captured).toHaveLength(1);

    resolvePut?.();
    await captured[0];
  });
});
