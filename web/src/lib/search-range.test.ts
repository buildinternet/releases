import { expect, test } from "bun:test";
import { DEFAULT_RANGE, parseRangeKey, rangeSince, SEARCH_RANGES } from "./search-range";

test("parseRangeKey accepts every known key", () => {
  for (const { key } of SEARCH_RANGES) {
    expect(parseRangeKey(key)).toBe(key);
  }
});

test("parseRangeKey falls back to the default for unknown/missing input", () => {
  expect(parseRangeKey(undefined)).toBe(DEFAULT_RANGE);
  expect(parseRangeKey(null)).toBe(DEFAULT_RANGE);
  expect(parseRangeKey("")).toBe(DEFAULT_RANGE);
  expect(parseRangeKey("5y")).toBe(DEFAULT_RANGE);
  expect(parseRangeKey("garbage")).toBe(DEFAULT_RANGE);
});

test("DEFAULT_RANGE is past year", () => {
  expect(DEFAULT_RANGE).toBe("1y");
});

test("rangeSince maps keys to API shorthand; 'any' has no bound", () => {
  expect(rangeSince("any")).toBeUndefined();
  expect(rangeSince("30d")).toBe("30d");
  expect(rangeSince("3m")).toBe("3m");
  expect(rangeSince("6m")).toBe("6m");
  expect(rangeSince("1y")).toBe("1y");
  expect(rangeSince("2y")).toBe("2y");
});
