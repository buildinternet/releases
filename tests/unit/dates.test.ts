import { describe, it, expect } from "bun:test";
import { daysAgoIso, timeAgo, inferMonthOnlyDate } from "@buildinternet/releases-core/dates";

describe("inferMonthOnlyDate", () => {
  it("returns the first of the month for a standard title", () => {
    expect(inferMonthOnlyDate("March 2026")).toBe("2026-03-01T00:00:00.000Z");
  });

  it("returns January correctly", () => {
    expect(inferMonthOnlyDate("January 2025")).toBe("2025-01-01T00:00:00.000Z");
  });

  it("returns December correctly", () => {
    expect(inferMonthOnlyDate("December 2025")).toBe("2025-12-01T00:00:00.000Z");
  });

  it("handles lowercase month names", () => {
    expect(inferMonthOnlyDate("march 2026")).toBe("2026-03-01T00:00:00.000Z");
  });

  it("handles uppercase month names", () => {
    expect(inferMonthOnlyDate("MARCH 2026")).toBe("2026-03-01T00:00:00.000Z");
  });

  it("handles mixed-case month names", () => {
    expect(inferMonthOnlyDate("mArCh 2026")).toBe("2026-03-01T00:00:00.000Z");
  });

  it("trims leading/trailing whitespace before matching", () => {
    expect(inferMonthOnlyDate("  April 2025  ")).toBe("2025-04-01T00:00:00.000Z");
  });

  it("returns null for a title with trailing punctuation", () => {
    expect(inferMonthOnlyDate("March 2026.")).toBeNull();
  });

  it("returns null for a century-1900 year", () => {
    expect(inferMonthOnlyDate("March 1999")).toBeNull();
  });

  it("returns null for a year before 2000", () => {
    expect(inferMonthOnlyDate("January 1000")).toBeNull();
  });

  it("returns null for a title with extra words", () => {
    expect(inferMonthOnlyDate("March 2026 update")).toBeNull();
  });

  it("returns null for a version-style title", () => {
    expect(inferMonthOnlyDate("v1.2.3")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(inferMonthOnlyDate("")).toBeNull();
  });

  it("returns null for a non-month word", () => {
    expect(inferMonthOnlyDate("Summer 2026")).toBeNull();
  });

  it("returns null for a date range title", () => {
    expect(inferMonthOnlyDate("March-April 2026")).toBeNull();
  });

  it("handles all twelve months", () => {
    const months = [
      ["January", "01"],
      ["February", "02"],
      ["March", "03"],
      ["April", "04"],
      ["May", "05"],
      ["June", "06"],
      ["July", "07"],
      ["August", "08"],
      ["September", "09"],
      ["October", "10"],
      ["November", "11"],
      ["December", "12"],
    ] as const;
    for (const [name, mm] of months) {
      expect(inferMonthOnlyDate(`${name} 2024`)).toBe(`2024-${mm}-01T00:00:00.000Z`);
    }
  });
});

describe("daysAgoIso", () => {
  it("returns an ISO string", () => {
    const result = daysAgoIso(7);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns a date approximately N days ago", () => {
    const result = new Date(daysAgoIso(1));
    const now = Date.now();
    const diff = now - result.getTime();
    // Should be within ~1 second of exactly 1 day
    expect(Math.abs(diff - 86_400_000)).toBeLessThan(1_000);
  });

  it("returns roughly now for 0 days", () => {
    const result = new Date(daysAgoIso(0));
    expect(Date.now() - result.getTime()).toBeLessThan(1_000);
  });
});

describe("timeAgo", () => {
  it("returns null for null input", () => {
    expect(timeAgo(null)).toBeNull();
  });

  it("returns 'just now' for recent timestamps", () => {
    expect(timeAgo(new Date().toISOString())).toBe("just now");
  });

  it("returns minutes for < 1 hour", () => {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    expect(timeAgo(thirtyMinAgo)).toBe("30m ago");
  });

  it("returns hours for < 24 hours", () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 3_600_000).toISOString();
    expect(timeAgo(fiveHoursAgo)).toBe("5h ago");
  });

  it("returns days for < 30 days", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    expect(timeAgo(tenDaysAgo)).toBe("10d ago");
  });

  it("returns months for >= 30 days", () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString();
    expect(timeAgo(ninetyDaysAgo)).toBe("3mo ago");
  });
});
