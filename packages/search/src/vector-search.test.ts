import { test, expect } from "bun:test";
import {
  reciprocalRankFusion,
  hybridSearch,
  type VectorizeIndex,
  type HybridFtsHit,
} from "./vector-search.js";

const K = 60;
const close = (a: number, b: number, eps = 1e-12) => Math.abs(a - b) < eps;

test("RRF: two crafted lists with hand-computed scores and order", () => {
  const list1 = [
    { id: "a", item: { name: "a" } },
    { id: "b", item: { name: "b" } },
    { id: "c", item: { name: "c" } },
  ];
  const list2 = [
    { id: "b", item: { name: "b2" } },
    { id: "c", item: { name: "c2" } },
    { id: "a", item: { name: "a2" } },
  ];

  const result = reciprocalRankFusion([list1, list2], { k: K });

  // Hand-computed contributions:
  // a: 1/(60+1) + 1/(60+3)
  // b: 1/(60+2) + 1/(60+1)
  // c: 1/(60+3) + 1/(60+2)
  const expectA = 1 / 61 + 1 / 63;
  const expectB = 1 / 62 + 1 / 61;
  const expectC = 1 / 63 + 1 / 62;

  // Order: b > a > c
  expect(result.map((r) => r.id)).toEqual(["b", "a", "c"]);
  const byId = Object.fromEntries(result.map((r) => [r.id, r]));
  expect(close(byId.a.score, expectA)).toBe(true);
  expect(close(byId.b.score, expectB)).toBe(true);
  expect(close(byId.c.score, expectC)).toBe(true);

  // All three appear in both lists
  expect(byId.a.appearances).toBe(2);
  expect(byId.b.appearances).toBe(2);
  expect(byId.c.appearances).toBe(2);

  // Tiebreak: first item seen is kept (list1's items)
  expect(byId.a.item).toEqual({ name: "a" });
  expect(byId.b.item).toEqual({ name: "b" });
  expect(byId.c.item).toEqual({ name: "c" });
});

test("RRF: single list degrades to original order with rank-based scores", () => {
  const list = [
    { id: "x", item: 1 },
    { id: "y", item: 2 },
    { id: "z", item: 3 },
  ];
  const result = reciprocalRankFusion([list], { k: K });
  expect(result.map((r) => r.id)).toEqual(["x", "y", "z"]);
  expect(close(result[0].score, 1 / 61)).toBe(true);
  expect(close(result[1].score, 1 / 62)).toBe(true);
  expect(close(result[2].score, 1 / 63)).toBe(true);
  for (const r of result) expect(r.appearances).toBe(1);
});

test("RRF: empty input returns empty array", () => {
  expect(reciprocalRankFusion<unknown>([])).toEqual([]);
});

test("RRF: empty list combined with populated list returns the populated items", () => {
  const populated = [
    { id: "a", item: "A" },
    { id: "b", item: "B" },
  ];
  const result = reciprocalRankFusion([[], populated], { k: K });
  expect(result.map((r) => r.id)).toEqual(["a", "b"]);
  expect(close(result[0].score, 1 / 61)).toBe(true);
  expect(close(result[1].score, 1 / 62)).toBe(true);
});

test("RRF: id deduplication sums contributions and counts appearances", () => {
  // id "x" appears at rank 1 in list1 and rank 2 in list2
  const list1 = [{ id: "x", item: "first" }];
  const list2 = [
    { id: "y", item: "Y" },
    { id: "x", item: "second" },
  ];
  const result = reciprocalRankFusion([list1, list2], { k: K });
  const x = result.find((r) => r.id === "x")!;
  expect(x.appearances).toBe(2);
  expect(close(x.score, 1 / 61 + 1 / 62)).toBe(true);
  // First-seen item kept
  expect(x.item).toBe("first");
});

// --- hybridSearch orchestration ---

function fakeIndex(matches: Array<{ id: string; score: number }>): VectorizeIndex {
  return {
    async query() {
      return { matches };
    },
    async upsert() {
      return { mutationId: "noop" };
    },
    async deleteByIds() {
      return { mutationId: "noop" };
    },
  };
}

test("hybridSearch: merges FTS + multiple vector indexes with correct kind precedence", async () => {
  const ftsHits: HybridFtsHit[] = [{ id: "rel_1" }, { id: "rel_2" }, { id: "rel_shared" }];
  const releaseIndex = fakeIndex([
    { id: "rel_shared", score: 0.99 }, // also in FTS
    { id: "rel_3", score: 0.88 },
  ]);
  const chunkIndex = fakeIndex([
    { id: "chunk_1", score: 0.95 },
    { id: "chunk_2", score: 0.85 },
  ]);

  let embedCalls = 0;
  const result = await hybridSearch({
    query: "test query",
    topK: 20,
    ftsSearch: async () => ftsHits,
    vectorIndexes: [
      { name: "releases-v1", kind: "release", index: releaseIndex },
      { name: "changelog-chunks-v1", kind: "changelog_chunk", index: chunkIndex },
    ],
    embed: async () => {
      embedCalls += 1;
      return [0.1, 0.2, 0.3];
    },
  });

  expect(embedCalls).toBeGreaterThan(0);

  // 3 FTS + 2 release + 2 chunk - 1 overlap (rel_shared) = 6 unique ids
  expect(result.length).toBe(6);

  const byId = Object.fromEntries(result.map((r) => [r.id, r]));

  // Vector-only hits keep their vector index kind
  expect(byId.chunk_1.kind).toBe("changelog_chunk");
  expect(byId.chunk_1.source).toBe("changelog-chunks-v1");
  expect(byId.rel_3.kind).toBe("release");
  expect(byId.rel_3.source).toBe("releases-v1");

  // FTS-only hits get the fallback "release" kind
  expect(byId.rel_1.kind).toBe("release");
  expect(byId.rel_1.source).toBe("fts");

  // Shared hit: vector kind/source wins precedence
  expect(byId.rel_shared.appearances).toBe(2);
  expect(byId.rel_shared.kind).toBe("release");
  expect(byId.rel_shared.source).toBe("releases-v1");
});

test("hybridSearch: honors topK cap", async () => {
  const ftsHits: HybridFtsHit[] = Array.from({ length: 50 }, (_, i) => ({
    id: `rel_${i}`,
  }));
  const result = await hybridSearch({
    query: "anything",
    topK: 10,
    ftsSearch: async () => ftsHits,
    vectorIndexes: [],
    embed: async () => [0],
  });
  expect(result.length).toBe(10);
});

test("hybridSearch: scoreMultipliers can flip ordering by a magnitude", async () => {
  // rel_old leads on FTS+vector, but rel_new gets a 10x decay multiplier.
  // With a continuous boost (unlike the previous rank-based attempt), a
  // strong multiplier can overcome a clear FTS+vector lead — which is the
  // whole point of moving to multiplicative decay.
  const ftsHits: HybridFtsHit[] = [{ id: "rel_old" }, { id: "rel_new" }];
  const releaseIndex = fakeIndex([
    { id: "rel_old", score: 0.9 },
    { id: "rel_new", score: 0.89 },
  ]);

  const baseline = await hybridSearch({
    query: "q",
    ftsSearch: async () => ftsHits,
    vectorIndexes: [{ name: "releases-v1", kind: "release", index: releaseIndex }],
    embed: async () => [0.1],
  });
  expect(baseline.map((r) => r.id)).toEqual(["rel_old", "rel_new"]);

  const boosted = await hybridSearch({
    query: "q",
    ftsSearch: async () => ftsHits,
    vectorIndexes: [{ name: "releases-v1", kind: "release", index: releaseIndex }],
    embed: async () => [0.1],
    scoreMultipliers: async () => new Map([["rel_new", 10]]),
  });
  expect(boosted.map((r) => r.id)).toEqual(["rel_new", "rel_old"]);
});

test("hybridSearch: scoreMultipliers missing ids default to 1.0 (pass-through)", async () => {
  const ftsHits: HybridFtsHit[] = [{ id: "rel_a" }, { id: "rel_b" }, { id: "rel_c" }];
  const result = await hybridSearch({
    query: "q",
    ftsSearch: async () => ftsHits,
    vectorIndexes: [],
    embed: async () => [0.1],
    // Only rel_a gets a non-1 multiplier; rel_b and rel_c pass through.
    scoreMultipliers: async () => new Map([["rel_a", 0.1]]),
  });
  // rel_a multiplied by 0.1 — drops below rel_b and rel_c which were at
  // rank 2 and 3 with no decay.
  expect(result.map((r) => r.id)).toEqual(["rel_b", "rel_c", "rel_a"]);
});

test("hybridSearch: scoreMultipliers of 1.0 leaves ordering identical to baseline", async () => {
  const ftsHits: HybridFtsHit[] = [{ id: "rel_a" }, { id: "rel_b" }, { id: "rel_c" }];
  const noOp = await hybridSearch({
    query: "q",
    ftsSearch: async () => ftsHits,
    vectorIndexes: [],
    embed: async () => [0.1],
    scoreMultipliers: async () =>
      new Map([
        ["rel_a", 1],
        ["rel_b", 1],
        ["rel_c", 1],
      ]),
  });
  expect(noOp.map((r) => r.id)).toEqual(["rel_a", "rel_b", "rel_c"]);
});

test("hybridSearch: scoreMultipliers of 0 sinks an entry to the bottom", async () => {
  const ftsHits: HybridFtsHit[] = [{ id: "rel_a" }, { id: "rel_b" }, { id: "rel_c" }];
  const result = await hybridSearch({
    query: "q",
    ftsSearch: async () => ftsHits,
    vectorIndexes: [],
    embed: async () => [0.1],
    scoreMultipliers: async () => new Map([["rel_a", 0]]),
  });
  // rel_a is zeroed; sort puts it last.
  expect(result.map((r) => r.id)).toEqual(["rel_b", "rel_c", "rel_a"]);
  expect(result.find((r) => r.id === "rel_a")?.score).toBe(0);
});

test("hybridSearch: scoreMultipliers throw is swallowed and base fusion stands", async () => {
  const ftsHits: HybridFtsHit[] = [{ id: "rel_a" }, { id: "rel_b" }];
  const releaseIndex = fakeIndex([{ id: "rel_a", score: 0.9 }]);
  const result = await hybridSearch({
    query: "q",
    ftsSearch: async () => ftsHits,
    vectorIndexes: [{ name: "releases-v1", kind: "release", index: releaseIndex }],
    embed: async () => [0.1],
    scoreMultipliers: async () => {
      throw new Error("D1 unavailable");
    },
  });
  expect(result.map((r) => r.id)).toEqual(["rel_a", "rel_b"]);
});

test("hybridSearch: empty query short-circuits and never builds a query vector", async () => {
  let embedCalls = 0;
  const ftsHits: HybridFtsHit[] = [{ id: "rel_1" }, { id: "rel_2" }];
  const vIndex = fakeIndex([{ id: "vec_1", score: 0.9 }]);

  const result = await hybridSearch({
    query: "   ",
    ftsSearch: async () => ftsHits,
    vectorIndexes: [{ name: "releases-v1", kind: "release", index: vIndex }],
    embed: async () => {
      embedCalls += 1;
      return [0.1];
    },
  });

  expect(embedCalls).toBe(0);
  expect(result.length).toBe(2);
  expect(result.map((r) => r.id).toSorted()).toEqual(["rel_1", "rel_2"]);
  for (const r of result) expect(r.source).toBe("fts");
});
