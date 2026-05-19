import { describe, test, expect } from "bun:test";
import { embedBatch, resolveConfig, getEmbedDim, VOYAGE_OUTPUT_DIMENSION } from "./embeddings";

type FakeCall = { url: string; init: RequestInit };

function makeFakeFetch(
  responder: (call: FakeCall, callIndex: number) => Response | Promise<Response>,
) {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FakeCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    return responder(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseBody(call: FakeCall): any {
  return JSON.parse(String(call.init.body));
}

describe("resolveConfig", () => {
  test("defaults to voyage + voyage-4-lite", () => {
    const prev = process.env.EMBEDDING_PROVIDER;
    delete process.env.EMBEDDING_PROVIDER;
    try {
      const cfg = resolveConfig();
      expect(cfg.provider).toBe("voyage");
      expect(cfg.model).toBe("voyage-4-lite");
    } finally {
      if (prev !== undefined) process.env.EMBEDDING_PROVIDER = prev;
    }
  });

  test("respects EMBEDDING_PROVIDER env var", () => {
    const prev = process.env.EMBEDDING_PROVIDER;
    process.env.EMBEDDING_PROVIDER = "openai";
    try {
      const cfg = resolveConfig();
      expect(cfg.provider).toBe("openai");
      expect(cfg.model).toBe("text-embedding-3-small");
    } finally {
      if (prev === undefined) delete process.env.EMBEDDING_PROVIDER;
      else process.env.EMBEDDING_PROVIDER = prev;
    }
  });

  test("throws on unknown provider", () => {
    expect(() => resolveConfig({ provider: "bogus" as any })).toThrow(/Unknown EMBEDDING_PROVIDER/);
  });
});

// Regression for #1041: the embedding cache key encodes (provider, model, dim).
// Before the fix, dim was hardcoded to VOYAGE_OUTPUT_DIMENSION on every
// caller — so flipping EMBEDDING_PROVIDER=openai would still key on 512
// while the wire-actual vector was 1536. `getEmbedDim` is what closes that.
describe("getEmbedDim", () => {
  test("voyage always reports VOYAGE_OUTPUT_DIMENSION regardless of model", () => {
    // We always request `output_dimension: VOYAGE_OUTPUT_DIMENSION` against
    // Voyage, so each model returns that dim irrespective of its native one.
    expect(getEmbedDim("voyage", "voyage-4-lite")).toBe(VOYAGE_OUTPUT_DIMENSION);
    expect(getEmbedDim("voyage", "voyage-4")).toBe(VOYAGE_OUTPUT_DIMENSION);
    expect(getEmbedDim("voyage", "voyage-3-lite")).toBe(VOYAGE_OUTPUT_DIMENSION);
  });

  test("openai reports each model's native dim", () => {
    expect(getEmbedDim("openai", "text-embedding-3-small")).toBe(1536);
    expect(getEmbedDim("openai", "text-embedding-3-large")).toBe(3072);
  });

  test("workers-ai reports each model's native dim", () => {
    expect(getEmbedDim("workers-ai", "@cf/baai/bge-base-en-v1.5")).toBe(768);
    expect(getEmbedDim("workers-ai", "@cf/baai/bge-small-en-v1.5")).toBe(384);
  });

  test("openai and voyage at the same query produce different dim → different cache key", () => {
    // Same model name slot, different providers — cache key inputs diverge.
    const voyageDim = getEmbedDim("voyage", "voyage-4-lite");
    const openaiDim = getEmbedDim("openai", "text-embedding-3-small");
    expect(voyageDim).not.toBe(openaiDim);
  });

  test("throws on unknown openai/workers-ai model", () => {
    expect(() => getEmbedDim("openai", "made-up-model")).toThrow(/Unknown embedding model/);
    expect(() => getEmbedDim("workers-ai", "@cf/bogus/model")).toThrow(/Unknown embedding model/);
  });
});

describe("voyage", () => {
  test("happy path", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() =>
      jsonResponse({
        data: [
          { embedding: [0.1, 0.2, 0.3], index: 0 },
          { embedding: [0.4, 0.5, 0.6], index: 1 },
        ],
        usage: { total_tokens: 42 },
      }),
    );
    const result = await embedBatch(["a", "b"], {
      provider: "voyage",
      apiKey: "test",
      fetchImpl,
    });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://api.voyageai.com/v1/embeddings");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test");
    const body = parseBody(calls[0]);
    expect(body.input_type).toBe("document");
    expect(body.model).toBe("voyage-4-lite");
    expect(body.output_dimension).toBe(512);
    expect(body.input).toEqual(["a", "b"]);
    expect(result.vectors).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
    expect(result.dims).toBe(3);
    expect(result.inputTokens).toBe(42);
    expect(result.provider).toBe("voyage");
  });

  test("sorts out-of-order indices", async () => {
    const { fetchImpl } = makeFakeFetch(() =>
      jsonResponse({
        data: [
          { embedding: [2, 2], index: 1 },
          { embedding: [1, 1], index: 0 },
        ],
      }),
    );
    const result = await embedBatch(["a", "b"], {
      provider: "voyage",
      apiKey: "k",
      fetchImpl,
    });
    expect(result.vectors).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  test("splits batches according to maxBatchSize", async () => {
    const { fetchImpl, calls } = makeFakeFetch((call) => {
      const body = parseBody(call);
      const data = body.input.map((_: string, i: number) => ({
        embedding: [i],
        index: i,
      }));
      return jsonResponse({ data });
    });
    const inputs = Array.from({ length: 150 }, (_, i) => `t${i}`);
    const result = await embedBatch(inputs, {
      provider: "voyage",
      apiKey: "k",
      fetchImpl,
      maxBatchSize: 50,
    });
    expect(calls.length).toBe(3);
    expect(result.vectors.length).toBe(150);
  });

  test("truncates inputs longer than 32_000 chars", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() =>
      jsonResponse({ data: [{ embedding: [1], index: 0 }] }),
    );
    const long = "x".repeat(50_000);
    await embedBatch([long], {
      provider: "voyage",
      apiKey: "k",
      fetchImpl,
    });
    const body = parseBody(calls[0]);
    expect(body.input[0].length).toBe(32_000);
  });

  test("truncate doesn't leave a lone surrogate at the cut (regression: #626)", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() =>
      jsonResponse({ data: [{ embedding: [1], index: 0 }] }),
    );
    // Place 🐛 (a surrogate pair) so that the high surrogate sits at index
    // 31_999 and the low surrogate at index 32_000 — exactly straddling
    // the truncate cut. Pre-fix, the truncated string ends with a lone
    // high surrogate; post-fix, it must be a complete codepoint.
    const long = "x".repeat(31_999) + "🐛" + "y".repeat(20_000);
    await embedBatch([long], { provider: "voyage", apiKey: "k", fetchImpl });
    const sent = parseBody(calls[0]).input[0] as string;
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(lone.test(sent)).toBe(false);
    expect(sent.length).toBe(31_999);
  });

  test("retries on 429", async () => {
    const { fetchImpl, calls } = makeFakeFetch((_, i) => {
      if (i === 0) return new Response("rate limited", { status: 429 });
      return jsonResponse({ data: [{ embedding: [1, 2], index: 0 }] });
    });
    const result = await embedBatch(["a"], {
      provider: "voyage",
      apiKey: "k",
      fetchImpl,
      maxRetries: 1,
    });
    expect(calls.length).toBe(2);
    expect(result.vectors).toEqual([[1, 2]]);
  });

  test("throws clear error when API key missing", async () => {
    let err: unknown;
    try {
      await embedBatch(["x"], { provider: "voyage" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/VOYAGE_API_KEY/);
  });
});

describe("openai", () => {
  test("happy path", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() =>
      jsonResponse({
        data: [
          { embedding: [0.1, 0.2], index: 0 },
          { embedding: [0.3, 0.4], index: 1 },
        ],
        usage: { total_tokens: 7 },
      }),
    );
    const result = await embedBatch(["a", "b"], {
      provider: "openai",
      apiKey: "sk-test",
      fetchImpl,
    });
    expect(calls[0].url).toBe("https://api.openai.com/v1/embeddings");
    const body = parseBody(calls[0]);
    expect(body.input_type).toBeUndefined();
    expect(body.model).toBe("text-embedding-3-small");
    expect(result.vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(result.provider).toBe("openai");
    expect(result.inputTokens).toBe(7);
  });
});

describe("workers-ai", () => {
  test("happy path", async () => {
    const seen: { model?: string; input?: { text: string[] } } = {};
    const workersAi = {
      async run(model: string, input: { text: string[] }) {
        seen.model = model;
        seen.input = input;
        return { data: [[1, 2, 3]] };
      },
    };
    const result = await embedBatch(["hello"], {
      provider: "workers-ai",
      workersAi,
    });
    expect(seen.model).toBe("@cf/baai/bge-base-en-v1.5");
    expect(seen.input).toEqual({ text: ["hello"] });
    expect(result.vectors).toEqual([[1, 2, 3]]);
    expect(result.dims).toBe(3);
    expect(result.provider).toBe("workers-ai");
  });
});

describe("embedBatch edge cases", () => {
  test("empty input short-circuits without calling fetch", async () => {
    const { fetchImpl, calls } = makeFakeFetch(() => {
      throw new Error("should not be called");
    });
    const result = await embedBatch([], { provider: "voyage", apiKey: "k", fetchImpl });
    expect(calls.length).toBe(0);
    expect(result.vectors).toEqual([]);
    expect(result.dims).toBe(0);
  });

  test("request timeout aborts the fetch and rejects quickly", async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
            return;
          }
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
        // otherwise hang forever
      });
    }) as unknown as typeof fetch;

    const started = Date.now();
    let err: unknown;
    try {
      await embedBatch(["x"], {
        provider: "voyage",
        apiKey: "k",
        fetchImpl,
        timeoutMs: 50,
        maxRetries: 0,
      });
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - started;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timed out/);
    expect(elapsed).toBeLessThan(500);
  });

  test("maxBatchSize: 0 throws with a clear error", async () => {
    let err: unknown;
    try {
      await embedBatch(["x"], {
        provider: "voyage",
        apiKey: "k",
        maxBatchSize: 0,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/maxBatchSize/);
  });
});
