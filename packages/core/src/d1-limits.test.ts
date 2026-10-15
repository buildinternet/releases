import { describe, expect, test } from "bun:test";
import {
  D1_MAX_BINDINGS,
  assertBindBudget,
  chunkArray,
  chunkForBindBudget,
  maxChunkLength,
} from "./d1-limits";

describe("chunkArray", () => {
  test("empty input returns an empty array", () => {
    expect(chunkArray([], 3)).toEqual([]);
  });

  test("exact multiple of size produces no trailing empty chunk", () => {
    expect(chunkArray([1, 2, 3, 4, 5, 6], 3)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  test("remainder produces a short final chunk", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("size larger than the input yields a single chunk", () => {
    expect(chunkArray([1, 2, 3], 90)).toEqual([[1, 2, 3]]);
  });

  test("a non-positive size throws instead of looping", () => {
    expect(() => chunkArray([1], 0)).toThrow(/chunk size/);
  });
});

describe("maxChunkLength", () => {
  test("a fully-bound releases row fits 3 per statement and not 4", () => {
    // 27 columns today. The exact count lives with the table; the invariant
    // is what keeps an INSERT under the cap when every column is bound.
    const bindsPerRow = 27;
    const chunk = maxChunkLength(bindsPerRow);
    expect(chunk * bindsPerRow).toBeLessThanOrEqual(D1_MAX_BINDINGS);
    expect((chunk + 1) * bindsPerRow).toBeGreaterThan(D1_MAX_BINDINGS);
    expect(D1_MAX_BINDINGS - chunk * bindsPerRow).toBeGreaterThan(0);
  });

  test("a same-day range (2 binds) plus a source id fits 49 days and not 50", () => {
    const chunk = maxChunkLength(2, 1);
    expect(1 + chunk * 2).toBeLessThanOrEqual(D1_MAX_BINDINGS);
    expect(1 + (chunk + 1) * 2).toBeGreaterThan(D1_MAX_BINDINGS);
  });

  test("refuses a shape that cannot fit one item", () => {
    expect(() => maxChunkLength(D1_MAX_BINDINGS + 1)).toThrow(/cannot fit one item/);
    expect(() => maxChunkLength(0)).toThrow(/bindsPerItem/);
  });
});

describe("chunkForBindBudget", () => {
  test("empty input returns an empty array", () => {
    expect(chunkForBindBudget([], 2, 1)).toEqual([]);
  });

  test("splits a long list so every chunk's binds stay under the cap", () => {
    const items = Array.from({ length: 200 }, (_, i) => i);
    const chunks = chunkForBindBudget(items, 2, 1);
    expect(chunks.flat()).toEqual(items);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(1 + chunk.length * 2).toBeLessThanOrEqual(D1_MAX_BINDINGS);
    }
    expect(chunks[0]?.length).toBe(maxChunkLength(2, 1));
  });
});

describe("assertBindBudget", () => {
  test("accepts a statement on the cap", () => {
    expect(() => assertBindBudget(D1_MAX_BINDINGS, "lookup")).not.toThrow();
  });

  test("throws once the cap is crossed, naming the call site", () => {
    expect(() => assertBindBudget(D1_MAX_BINDINGS + 1, "content-identity day lookup")).toThrow(
      /content-identity day lookup/,
    );
  });
});
