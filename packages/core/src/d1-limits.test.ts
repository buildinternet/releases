import { describe, expect, test } from "bun:test";
import { chunkArray } from "./d1-limits";

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
});
