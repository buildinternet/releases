import { describe, expect, test } from "bun:test";
import { formatStars } from "./format-stars";

describe("formatStars", () => {
  test("passes through counts under 1,000", () => {
    expect(formatStars(0)).toBe("0");
    expect(formatStars(1)).toBe("1");
    expect(formatStars(999)).toBe("999");
  });
  test("compacts thousands", () => {
    expect(formatStars(1000)).toBe("1k");
    expect(formatStars(1234)).toBe("1.2k");
    expect(formatStars(12345)).toBe("12.3k");
  });
  test("compacts millions", () => {
    expect(formatStars(1_500_000)).toBe("1.5M");
  });
  test("rolls the high-thousands boundary up to M, not 1000k", () => {
    expect(formatStars(999_499)).toBe("999k");
    expect(formatStars(999_500)).toBe("1M"); // exact cutover point
    expect(formatStars(999_999)).toBe("1M");
  });
  test("renders very large counts in M (no billions unit)", () => {
    expect(formatStars(1_500_000_000)).toBe("1500M");
  });
  test("falls back to '0' for non-finite or negative input", () => {
    expect(formatStars(-100)).toBe("0");
    expect(formatStars(Number.NaN)).toBe("0");
    expect(formatStars(Number.POSITIVE_INFINITY)).toBe("0");
  });
});
