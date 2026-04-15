import { describe, test, expect } from "bun:test";
import { embedAndUpsertEntities, type EmbedEntityInput } from "./embed-entities";
import type { VectorizeIndex } from "./vector-search";

function fakeVoyageFetch() {
  const calls: Array<{ body: any }> = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ body });
    const data = body.input.map((_: string, i: number) => ({
      embedding: [i + 1, i + 1],
      index: i,
    }));
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function fakeVectorize(opts: { upsertThrows?: boolean } = {}) {
  const upserted: any[] = [];
  const index: VectorizeIndex = {
    async upsert(v: any[]) {
      if (opts.upsertThrows) throw new Error("vec down");
      upserted.push(...v);
      return { mutationId: "m1" };
    },
    async deleteByIds() {
      return { mutationId: "m2" };
    },
    async query() {
      return { matches: [] } as any;
    },
  } as VectorizeIndex;
  return { index, upserted };
}

function captureLogger() {
  const warns: string[] = [];
  return {
    warn: (...args: unknown[]) => warns.push(args.map(String).join(" ")),
    error: (..._args: unknown[]) => {},
    warns,
  };
}

describe("embedAndUpsertEntities", () => {
  test("empty input short-circuits", async () => {
    const { fetchImpl, calls } = fakeVoyageFetch();
    const vec = fakeVectorize();
    let persisted = 0;
    await embedAndUpsertEntities({
      entities: [],
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
      onPersisted: async () => {
        persisted++;
      },
    });
    expect(calls.length).toBe(0);
    expect(vec.upserted.length).toBe(0);
    expect(persisted).toBe(0);
  });

  test("text payload joins name + description + category + domain (trim, drop empty)", async () => {
    const { fetchImpl, calls } = fakeVoyageFetch();
    const vec = fakeVectorize();
    const entities: EmbedEntityInput[] = [
      {
        id: "org_acme",
        kind: "org",
        name: "Acme",
        description: "Cloud company",
        category: "cloud",
        domain: "acme.com",
      },
      {
        id: "prod_widget",
        kind: "product",
        name: "Widget",
        description: null,
        category: null,
        domain: null,
      },
    ];
    await embedAndUpsertEntities({
      entities,
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
    });
    expect(calls[0].body.input).toEqual([
      "Acme Cloud company cloud acme.com",
      "Widget",
    ]);
  });

  test("vector ID = entity id; metadata kind discriminator set per entity", async () => {
    const { fetchImpl } = fakeVoyageFetch();
    const vec = fakeVectorize();
    const entities: EmbedEntityInput[] = [
      { id: "org_a", kind: "org", name: "A", category: "cloud" },
      { id: "prod_b", kind: "product", name: "B" },
      { id: "src_c", kind: "source", name: "C", category: "ai" },
    ];
    await embedAndUpsertEntities({
      entities,
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
    });
    expect(vec.upserted.map((v: any) => v.id)).toEqual([
      "org_a",
      "prod_b",
      "src_c",
    ]);
    expect(vec.upserted[0].metadata).toEqual({ type: "org", category: "cloud" });
    expect(vec.upserted[1].metadata).toEqual({ type: "product" });
    expect(vec.upserted[2].metadata).toEqual({ type: "source", category: "ai" });
  });

  test("onPersisted called with all entity ids on success", async () => {
    const { fetchImpl } = fakeVoyageFetch();
    const vec = fakeVectorize();
    const persisted: string[][] = [];
    await embedAndUpsertEntities({
      entities: [
        { id: "org_1", kind: "org", name: "x" },
        { id: "org_2", kind: "org", name: "y" },
      ],
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
      onPersisted: async (ids) => {
        persisted.push(ids);
      },
    });
    expect(persisted).toEqual([["org_1", "org_2"]]);
  });

  test("embed failure → logs, no upsert, no onPersisted", async () => {
    const fetchImpl = (async () =>
      new Response("err", { status: 400 })) as unknown as typeof fetch;
    const vec = fakeVectorize();
    const logger = captureLogger();
    let persistedCalled = false;
    await embedAndUpsertEntities({
      entities: [{ id: "org_1", kind: "org", name: "x" }],
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

  test("upsert failure → logs, no onPersisted", async () => {
    const { fetchImpl } = fakeVoyageFetch();
    const vec = fakeVectorize({ upsertThrows: true });
    const logger = captureLogger();
    let persistedCalled = false;
    await embedAndUpsertEntities({
      entities: [{ id: "org_1", kind: "org", name: "x" }],
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
      onPersisted: async () => {
        persistedCalled = true;
      },
      logger,
    });
    expect(persistedCalled).toBe(false);
    expect(logger.warns.some((w) => w.includes("Vectorize upsert failed"))).toBe(
      true,
    );
  });

  test("onPersisted failure is caught and logged", async () => {
    const { fetchImpl } = fakeVoyageFetch();
    const vec = fakeVectorize();
    const logger = captureLogger();
    await embedAndUpsertEntities({
      entities: [{ id: "org_1", kind: "org", name: "x" }],
      vectorIndex: vec.index,
      embedConfig: { provider: "voyage", apiKey: "k", fetchImpl },
      onPersisted: async () => {
        throw new Error("db down");
      },
      logger,
    });
    expect(
      logger.warns.some((w) => w.includes("onPersisted callback failed")),
    ).toBe(true);
  });
});
