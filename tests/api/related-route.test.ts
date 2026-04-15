import { describe, test, expect } from "bun:test";
import {
  parseScope,
  parseLimit,
  pickCandidates,
} from "../../workers/api/src/routes/related.js";

// These tests cover the pure pieces of the /v1/related route. The route
// itself binds to D1 + Vectorize which are both Worker-only, so full
// integration coverage lives in smoke tests against the deployed worker.
// Keeping the unit tests small and focused on query-parsing + anchor
// exclusion gives us the high-value invariants without mocking the world.

describe("parseScope", () => {
  test("'org' → 'org'", () => {
    expect(parseScope("org")).toBe("org");
  });

  test("'global' → 'global'", () => {
    expect(parseScope("global")).toBe("global");
  });

  test("unknown / missing → 'global' (safe default)", () => {
    expect(parseScope(undefined)).toBe("global");
    expect(parseScope("")).toBe("global");
    expect(parseScope("team")).toBe("global");
  });
});

describe("parseLimit", () => {
  test("valid positive integers pass through", () => {
    expect(parseLimit("5")).toBe(5);
    expect(parseLimit("1")).toBe(1);
  });

  test("missing / invalid fall back to default", () => {
    expect(parseLimit(undefined)).toBe(6);
    expect(parseLimit("")).toBe(6);
    expect(parseLimit("abc")).toBe(6);
    expect(parseLimit("0")).toBe(6);
    expect(parseLimit("-3")).toBe(6);
  });

  test("over-cap values are clamped to the cap", () => {
    expect(parseLimit("999")).toBe(20);
    expect(parseLimit("21")).toBe(20);
  });

  test("custom fallback + cap", () => {
    expect(parseLimit(undefined, 3, 10)).toBe(3);
    expect(parseLimit("50", 3, 10)).toBe(10);
  });
});

describe("pickCandidates", () => {
  const matches = [
    { id: "rel_anchor", score: 0.99 },
    { id: "rel_a", score: 0.88 },
    { id: "rel_b", score: 0.77 },
    { id: "rel_c", score: 0.66 },
    { id: "rel_d", score: 0.55 },
    { id: "rel_e", score: 0.44 },
  ];

  test("excludes the anchor from its own results", () => {
    const out = pickCandidates(matches, "rel_anchor", 5);
    expect(out).not.toContain("rel_anchor");
  });

  test("preserves Vectorize ranking order", () => {
    const out = pickCandidates(matches, "rel_anchor", 10);
    expect(out).toEqual(["rel_a", "rel_b", "rel_c", "rel_d", "rel_e"]);
  });

  test("over-fetches 2x the limit for post-filter headroom", () => {
    // limit=2 → stop at 4 candidates (2x over-fetch)
    const out = pickCandidates(matches, "rel_anchor", 2);
    expect(out.length).toBe(4);
  });

  test("prefix filter drops non-matching ids", () => {
    const mixed = [
      { id: "src_anchor", score: 1 },
      { id: "org_foo", score: 0.9 },
      { id: "src_a", score: 0.8 },
      { id: "prod_bar", score: 0.7 },
      { id: "src_b", score: 0.6 },
    ];
    const out = pickCandidates(mixed, "src_anchor", 5, "src_");
    expect(out).toEqual(["src_a", "src_b"]);
  });

  test("empty matches → empty list", () => {
    expect(pickCandidates([], "rel_anchor", 5)).toEqual([]);
  });

  test("only-anchor matches → empty list", () => {
    expect(
      pickCandidates([{ id: "rel_anchor", score: 1 }], "rel_anchor", 5),
    ).toEqual([]);
  });
});
