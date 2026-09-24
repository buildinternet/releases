import { describe, expect, test } from "bun:test";
import {
  etDayKey,
  etDayBoundsUtc,
  addDaysToDateKey,
  isDateKey,
  etWeekStart,
  weekBoundsUtc,
  weekSlug,
  parseWeekSlug,
  daysAgoIso,
  timeAgo,
  inferMonthOnlyDate,
  resolveDateParam,
} from "./dates";

describe("etDayKey", () => {
  test("maps a UTC instant to its Eastern calendar day", () => {
    // 2026-06-12T03:30:00Z is 2026-06-11 23:30 EDT — still the 11th in ET.
    expect(etDayKey("2026-06-12T03:30:00Z")).toBe("2026-06-11");
    // 2026-01-12T04:30:00Z is 2026-01-11 23:30 EST — still the 11th in ET.
    expect(etDayKey("2026-01-12T04:30:00Z")).toBe("2026-01-11");
    // Midday UTC stays on the same calendar day.
    expect(etDayKey("2026-06-12T16:00:00Z")).toBe("2026-06-12");
  });
});

describe("etDayBoundsUtc", () => {
  test("returns [start,end) UTC instants for an EDT day (UTC-4)", () => {
    expect(etDayBoundsUtc("2026-06-11")).toEqual({
      startUtc: "2026-06-11T04:00:00.000Z",
      endUtc: "2026-06-12T04:00:00.000Z",
    });
  });
  test("returns [start,end) UTC instants for an EST day (UTC-5)", () => {
    expect(etDayBoundsUtc("2026-01-11")).toEqual({
      startUtc: "2026-01-11T05:00:00.000Z",
      endUtc: "2026-01-12T05:00:00.000Z",
    });
  });
  test("spring-forward day is 23 hours (2026-03-08)", () => {
    expect(etDayBoundsUtc("2026-03-08")).toEqual({
      startUtc: "2026-03-08T05:00:00.000Z",
      endUtc: "2026-03-09T04:00:00.000Z",
    });
  });
  test("fall-back day is 25 hours (2026-11-01)", () => {
    expect(etDayBoundsUtc("2026-11-01")).toEqual({
      startUtc: "2026-11-01T04:00:00.000Z",
      endUtc: "2026-11-02T05:00:00.000Z",
    });
  });
});

describe("addDaysToDateKey", () => {
  test("adds and subtracts whole days on a YYYY-MM-DD key", () => {
    expect(addDaysToDateKey("2026-06-11", -1)).toBe("2026-06-10");
    expect(addDaysToDateKey("2026-06-30", 1)).toBe("2026-07-01");
  });
});

describe("isDateKey", () => {
  test("accepts real YYYY-MM-DD calendar dates", () => {
    expect(isDateKey("2026-06-11")).toBe(true);
    expect(isDateKey("2024-02-29")).toBe(true); // leap day
  });
  test("rejects bad shapes and impossible dates", () => {
    expect(isDateKey("2026-6-1")).toBe(false);
    expect(isDateKey("2026/06/11")).toBe(false);
    expect(isDateKey("garbage")).toBe(false);
    expect(isDateKey("")).toBe(false);
    expect(isDateKey("2026-13-01")).toBe(false);
    expect(isDateKey("2026-02-30")).toBe(false);
    expect(isDateKey("2026-06-11T00:00:00Z")).toBe(false);
  });
});

describe("etWeekStart", () => {
  test("resolves any day in the week to the same Monday", () => {
    expect(etWeekStart("2026-07-06")).toBe("2026-07-06"); // Monday itself
    expect(etWeekStart("2026-07-11")).toBe("2026-07-06"); // Saturday
    expect(etWeekStart("2026-07-12")).toBe("2026-07-06"); // Sunday (end of week)
    expect(etWeekStart("2026-07-13")).toBe("2026-07-13"); // next Monday
  });
});

describe("weekBoundsUtc", () => {
  test("returns a 168h week outside any DST transition", () => {
    const { startUtc, endUtc } = weekBoundsUtc("2026-06-08"); // Mon, EDT throughout
    expect(startUtc).toBe("2026-06-08T04:00:00.000Z");
    expect(endUtc).toBe("2026-06-15T04:00:00.000Z");
  });
  test("spring-forward week (2026-03-08) is 167 hours", () => {
    expect(weekBoundsUtc("2026-03-02")).toEqual({
      startUtc: "2026-03-02T05:00:00.000Z",
      endUtc: "2026-03-09T04:00:00.000Z",
    });
  });
  test("fall-back week (2026-11-01) is 169 hours", () => {
    expect(weekBoundsUtc("2026-10-26")).toEqual({
      startUtc: "2026-10-26T04:00:00.000Z",
      endUtc: "2026-11-02T05:00:00.000Z",
    });
  });
});

describe("weekSlug / parseWeekSlug", () => {
  test("round-trips a Monday date key", () => {
    expect(weekSlug("2026-07-06")).toBe("2026-07-06");
    expect(parseWeekSlug("2026-07-06")).toBe("2026-07-06");
  });
  test("parseWeekSlug rejects malformed or impossible dates", () => {
    expect(parseWeekSlug("garbage")).toBeNull();
    expect(parseWeekSlug("2026-13-01")).toBeNull();
    expect(parseWeekSlug("")).toBeNull();
  });
});

describe("inferMonthOnlyDate", () => {
  test("returns the first of the month for a standard title", () => {
    expect(inferMonthOnlyDate("March 2026")).toBe("2026-03-01T00:00:00.000Z");
  });

  test("returns January correctly", () => {
    expect(inferMonthOnlyDate("January 2025")).toBe("2025-01-01T00:00:00.000Z");
  });

  test("returns December correctly", () => {
    expect(inferMonthOnlyDate("December 2025")).toBe("2025-12-01T00:00:00.000Z");
  });

  test("handles lowercase month names", () => {
    expect(inferMonthOnlyDate("march 2026")).toBe("2026-03-01T00:00:00.000Z");
  });

  test("handles uppercase month names", () => {
    expect(inferMonthOnlyDate("MARCH 2026")).toBe("2026-03-01T00:00:00.000Z");
  });

  test("handles mixed-case month names", () => {
    expect(inferMonthOnlyDate("mArCh 2026")).toBe("2026-03-01T00:00:00.000Z");
  });

  test("trims leading/trailing whitespace before matching", () => {
    expect(inferMonthOnlyDate("  April 2025  ")).toBe("2025-04-01T00:00:00.000Z");
  });

  test("returns null for a title with trailing punctuation", () => {
    expect(inferMonthOnlyDate("March 2026.")).toBeNull();
  });

  test("returns null for a century-1900 year", () => {
    expect(inferMonthOnlyDate("March 1999")).toBeNull();
  });

  test("returns null for a year before 2000", () => {
    expect(inferMonthOnlyDate("January 1000")).toBeNull();
  });

  test("returns null for a title with extra words", () => {
    expect(inferMonthOnlyDate("March 2026 update")).toBeNull();
  });

  test("returns null for a version-style title", () => {
    expect(inferMonthOnlyDate("v1.2.3")).toBeNull();
  });

  test("returns null for an empty string", () => {
    expect(inferMonthOnlyDate("")).toBeNull();
  });

  test("returns null for a non-month word", () => {
    expect(inferMonthOnlyDate("Summer 2026")).toBeNull();
  });

  test("returns null for a date range title", () => {
    expect(inferMonthOnlyDate("March-April 2026")).toBeNull();
  });

  test("handles all twelve months", () => {
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
  test("returns an ISO string", () => {
    const result = daysAgoIso(7);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("returns a date approximately N days ago", () => {
    const result = new Date(daysAgoIso(1));
    const now = Date.now();
    const diff = now - result.getTime();
    // Should be within ~1 second of exactly 1 day
    expect(Math.abs(diff - 86_400_000)).toBeLessThan(1_000);
  });

  test("returns roughly now for 0 days", () => {
    const result = new Date(daysAgoIso(0));
    expect(Date.now() - result.getTime()).toBeLessThan(1_000);
  });
});

describe("resolveDateParam", () => {
  // Fixed reference point so relative-shorthand assertions are deterministic.
  const now = new Date("2026-05-22T12:00:00.000Z");

  test("normalizes an ISO date to a canonical UTC timestamp", () => {
    expect(resolveDateParam("2026-01-01")).toBe("2026-01-01T00:00:00.000Z");
  });

  test("normalizes an ISO datetime to a canonical UTC timestamp", () => {
    expect(resolveDateParam("2026-01-01T12:30:00Z")).toBe("2026-01-01T12:30:00.000Z");
  });

  test("resolves a days shorthand counted back from now", () => {
    expect(resolveDateParam("90d", now)).toBe("2026-02-21T12:00:00.000Z");
  });

  test("resolves a weeks shorthand (7 days each)", () => {
    expect(resolveDateParam("4w", now)).toBe("2026-04-24T12:00:00.000Z");
  });

  test("resolves a months shorthand using calendar months", () => {
    expect(resolveDateParam("6m", now)).toBe("2025-11-22T12:00:00.000Z");
  });

  test("resolves a years shorthand using calendar years", () => {
    expect(resolveDateParam("2y", now)).toBe("2024-05-22T12:00:00.000Z");
  });

  test("is case-insensitive on the unit and tolerates surrounding whitespace", () => {
    expect(resolveDateParam("  90D ", now)).toBe("2026-02-21T12:00:00.000Z");
    expect(resolveDateParam("6M", now)).toBe("2025-11-22T12:00:00.000Z");
  });

  test("treats 0 as now", () => {
    expect(resolveDateParam("0d", now)).toBe("2026-05-22T12:00:00.000Z");
  });

  test("defaults `now` to the current time for relative input", () => {
    const result = resolveDateParam("1d");
    expect(result).not.toBeNull();
    const diff = Date.now() - new Date(result!).getTime();
    expect(Math.abs(diff - 86_400_000)).toBeLessThan(1_000);
  });

  test("returns null for an empty or whitespace-only string", () => {
    expect(resolveDateParam("")).toBeNull();
    expect(resolveDateParam("   ")).toBeNull();
  });

  test("returns null for a bare number with no unit", () => {
    expect(resolveDateParam("90")).toBeNull();
  });

  test("returns null for an unknown unit", () => {
    expect(resolveDateParam("90x")).toBeNull();
  });

  test("returns null for a negative or fractional shorthand", () => {
    expect(resolveDateParam("-5d")).toBeNull();
    expect(resolveDateParam("1.5d")).toBeNull();
  });

  test("returns null for unparseable garbage", () => {
    expect(resolveDateParam("not-a-date")).toBeNull();
    expect(resolveDateParam("2026-13-45")).toBeNull();
  });

  test("returns null for a non-ISO date string", () => {
    expect(resolveDateParam("Jan 1, 2026")).toBeNull();
    expect(resolveDateParam("2026/01/01")).toBeNull();
  });

  test("returns null for a datetime without an explicit timezone (ambiguous local time)", () => {
    expect(resolveDateParam("2026-01-01T12:30:00")).toBeNull();
  });

  test("accepts a timezone offset and normalizes to UTC", () => {
    expect(resolveDateParam("2026-01-01T12:30:00+05:00")).toBe("2026-01-01T07:30:00.000Z");
  });
});

describe("timeAgo", () => {
  test("returns null for null input", () => {
    expect(timeAgo(null)).toBeNull();
  });

  test("returns 'just now' for recent timestamps", () => {
    expect(timeAgo(new Date().toISOString())).toBe("just now");
  });

  test("returns minutes for < 1 hour", () => {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    expect(timeAgo(thirtyMinAgo)).toBe("30m ago");
  });

  test("returns hours for < 24 hours", () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 3_600_000).toISOString();
    expect(timeAgo(fiveHoursAgo)).toBe("5h ago");
  });

  test("returns days for < 30 days", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    expect(timeAgo(tenDaysAgo)).toBe("10d ago");
  });

  test("returns months for >= 30 days", () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString();
    expect(timeAgo(ninetyDaysAgo)).toBe("3mo ago");
  });
});
