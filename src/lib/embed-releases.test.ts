import { describe, test, expect } from "bun:test";
import { embedAndUpsertReleases, type EmbedReleaseInput } from "./embed-releases";
import type { VectorizeIndex } from "./vector-search";

/**
 * Build a fake Voyage-shaped fetch that returns deterministic vectors and
 * records what it saw. Each text in the batch maps to a 3-dim vector
 * `[i, i, i]` so we can assert ordering.
 */
function fakeVoyageFetch() {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(url), body });
    const data = body.input.map((_: string, i: number) => ({
      embedding: [i, i, i],
      index: i,
    }));
    return new Response(JSON.stringify({ data, usage: { total_tokens: 1 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function fakeVectorize(
  opts: {
    upsertThrows?: boolean;
  } = {},
) {
  const upserted: any[] = [];
  const deleted: string[] = [];
  const index: VectorizeIndex = {
    async upsert(v: any[]) {
      if (opts.upsertThrows) throw new Error("vectorize boom");
      upserted.push(...v);
      return { mutationId: "m1" };
    },
    async deleteByIds(ids: string[]) {
      deleted.push(...ids);
      return { mutationId: "m2" };
    },
    async query() {
      return { matches: [] } as any;
    },
  } as VectorizeIndex;
  return { index, upserted, deleted };
}

function captureLogger() {
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    warn: (...args: unknown[]) => warns.push(args.map(String).join(" ")),
    error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
    warns,
    errors,
  };
}

const baseRelease: EmbedReleaseInput = {
  id: "rel_1",
  title: "v1.0",
  content: "long body content",
  contentSummary: "short summary",
  version: "1.0.0",
  publishedAt: "2026-01-01T00:00:00Z",
  sourceId: "src_1",
  orgId: "org_1",
  productId: "prod_1",
  category: "developer-tools",
  type: "feature",
};

describe("embedAndUpsertReleases", () => {
  test("empty input short-circuits without touching embedder or vectorIndex", async () => {
    const { fetchImpl, calls } = fakeVoyageFetch();
    const vec = fakeVectorize();
    let persistedCalls = 0;
    await embedAndUpsertReleases({
      releases: [],
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
      onPersisted: async () => {
        persistedCalls++;
      },
    });
    expect(calls.length).toBe(0);
    expect(vec.upserted.length).toBe(0);
    expect(persistedCalls).toBe(0);
  });

  test("builds text from title + version + summary, calls embed once, upserts with metadata", async () => {
    const { fetchImpl, calls } = fakeVoyageFetch();
    const vec = fakeVectorize();
    const persisted: string[][] = [];
    await embedAndUpsertReleases({
      releases: [baseRelease],
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
      onPersisted: async (ids) => {
        persisted.push(ids);
      },
    });
    expect(calls.length).toBe(1);
    expect(calls[0].body.input).toEqual(["v1.0\n1.0.0\nshort summary"]);
    expect(vec.upserted.length).toBe(1);
    expect(vec.upserted[0].id).toBe("rel_1");
    expect(vec.upserted[0].values).toEqual([0, 0, 0]);
    expect(vec.upserted[0].metadata).toEqual({
      type: "release",
      source_id: "src_1",
      release_type: "feature",
      org_id: "org_1",
      product_id: "prod_1",
      category: "developer-tools",
      published_at: "2026-01-01T00:00:00Z",
    });
    expect(persisted).toEqual([["rel_1"]]);
  });

  test("falls back to first 4k chars of content when summary is null/empty", async () => {
    const { fetchImpl, calls } = fakeVoyageFetch();
    const vec = fakeVectorize();
    const longBody = "x".repeat(5000);
    await embedAndUpsertReleases({
      releases: [{ ...baseRelease, contentSummary: null, content: longBody, version: null }],
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
    });
    const text = calls[0].body.input[0] as string;
    expect(text.startsWith("v1.0\n")).toBe(true);
    // title + newline + 4000 chars
    expect(text.length).toBe("v1.0\n".length + 4000);
  });

  test("omits optional metadata fields when nullish", async () => {
    const { fetchImpl } = fakeVoyageFetch();
    const vec = fakeVectorize();
    await embedAndUpsertReleases({
      releases: [
        {
          ...baseRelease,
          orgId: null,
          productId: null,
          category: null,
          publishedAt: null,
        },
      ],
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
    });
    const meta = vec.upserted[0].metadata;
    expect(meta.org_id).toBeUndefined();
    expect(meta.product_id).toBeUndefined();
    expect(meta.category).toBeUndefined();
    expect(meta.published_at).toBeUndefined();
    expect(meta.type).toBe("release");
    expect(meta.release_type).toBe("feature");
  });

  test("embedding failure → logs, does NOT throw, does NOT call onPersisted", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 400 })) as unknown as typeof fetch;
    const vec = fakeVectorize();
    const logger = captureLogger();
    let persistedCalled = false;
    await embedAndUpsertReleases({
      releases: [baseRelease],
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl, maxRetries: 0 },
      onPersisted: async () => {
        persistedCalled = true;
      },
      logger,
    });
    expect(vec.upserted.length).toBe(0);
    expect(persistedCalled).toBe(false);
    expect(logger.warns.some((w) => w.includes("embed pipeline failed"))).toBe(true);
  });

  test("upsert failure → logs, does NOT throw, does NOT call onPersisted", async () => {
    const { fetchImpl } = fakeVoyageFetch();
    const vec = fakeVectorize({ upsertThrows: true });
    const logger = captureLogger();
    let persistedCalled = false;
    await embedAndUpsertReleases({
      releases: [baseRelease],
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
      onPersisted: async () => {
        persistedCalled = true;
      },
      logger,
    });
    expect(persistedCalled).toBe(false);
    expect(logger.warns.some((w) => w.includes("Vectorize upsert failed"))).toBe(true);
  });

  test("onPersisted callback failure is caught and logged", async () => {
    const { fetchImpl } = fakeVoyageFetch();
    const vec = fakeVectorize();
    const logger = captureLogger();
    await embedAndUpsertReleases({
      releases: [baseRelease],
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
      onPersisted: async () => {
        throw new Error("db down");
      },
      logger,
    });
    expect(logger.warns.some((w) => w.includes("onPersisted callback failed"))).toBe(true);
  });

  test("multi-release batch: ids in order, each gets its own vector slot", async () => {
    const { fetchImpl } = fakeVoyageFetch();
    const vec = fakeVectorize();
    const persisted: string[][] = [];
    await embedAndUpsertReleases({
      releases: [
        { ...baseRelease, id: "rel_a" },
        { ...baseRelease, id: "rel_b" },
        { ...baseRelease, id: "rel_c" },
      ],
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
      onPersisted: async (ids) => {
        persisted.push(ids);
      },
    });
    expect(vec.upserted.map((v: any) => v.id)).toEqual(["rel_a", "rel_b", "rel_c"]);
    expect(vec.upserted[0].values).toEqual([0, 0, 0]);
    expect(vec.upserted[1].values).toEqual([1, 1, 1]);
    expect(vec.upserted[2].values).toEqual([2, 2, 2]);
    expect(persisted).toEqual([["rel_a", "rel_b", "rel_c"]]);
  });
});
