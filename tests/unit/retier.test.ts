import { describe, expect, it } from "bun:test";
import { computeMedianGapDays, classifyTier } from "../../workers/api/src/cron/retier";

describe("computeMedianGapDays", () => {
  it("returns infinity for fewer than 2 dates", () => {
    expect(computeMedianGapDays([])).toBe(Number.POSITIVE_INFINITY);
    expect(computeMedianGapDays(["2026-04-01T00:00:00Z"])).toBe(Number.POSITIVE_INFINITY);
  });

  it("computes gap for exactly two dates", () => {
    const dates = ["2026-04-01T00:00:00Z", "2026-04-08T00:00:00Z"];
    expect(computeMedianGapDays(dates)).toBe(7);
  });

  it("averages the two middle gaps for an even number of gaps", () => {
    // 3 dates → 2 gaps; median = average of the two (even gap count)
    const dates = [
      "2026-04-01T00:00:00Z",
      "2026-04-02T00:00:00Z", // 1-day gap
      "2026-04-10T00:00:00Z", // 8-day gap
    ];
    // Sorted gaps [1, 8]; median of even-count set = (1 + 8) / 2 = 4.5
    expect(computeMedianGapDays(dates)).toBe(4.5);
  });

  it("returns the middle sorted gap for odd gap counts", () => {
    // 4 dates → 3 gaps; median = middle value after sort
    const dates = [
      "2026-04-01T00:00:00Z",
      "2026-04-02T00:00:00Z", // 1-day
      "2026-04-12T00:00:00Z", // 10-day
      "2026-04-14T00:00:00Z", // 2-day
    ];
    // Sorted gaps [1, 2, 10]; median = 2
    expect(computeMedianGapDays(dates)).toBe(2);
  });

  it("handles out-of-order input by sorting first", () => {
    const dates = [
      "2026-04-14T00:00:00Z",
      "2026-04-01T00:00:00Z",
      "2026-04-08T00:00:00Z",
    ];
    // Sorted: 04-01, 04-08, 04-14 → gaps [7, 6] → median = 6.5
    expect(computeMedianGapDays(dates)).toBe(6.5);
  });

  it("drops invalid timestamps rather than poisoning the median", () => {
    const dates = [
      "2026-04-01T00:00:00Z",
      "not-a-date",
      "2026-04-08T00:00:00Z",
    ];
    expect(computeMedianGapDays(dates)).toBe(7);
  });
});

describe("classifyTier", () => {
  it("returns normal at or below the 14-day threshold", () => {
    expect(classifyTier(14, "low")).toBe("normal");
    expect(classifyTier(3, "normal")).toBe("normal");
    expect(classifyTier(0.1, "low")).toBe("normal");
  });

  it("returns low between 14 and 90 days", () => {
    expect(classifyTier(15, "normal")).toBe("low");
    expect(classifyTier(60, "normal")).toBe("low");
    expect(classifyTier(90, "normal")).toBe("low");
  });

  it("preserves current tier above 90 days (no auto-pause)", () => {
    expect(classifyTier(120, "normal")).toBe("normal");
    expect(classifyTier(365, "low")).toBe("low");
  });
});
