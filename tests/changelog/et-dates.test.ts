import { describe, expect, test } from "bun:test";
import { etDayOf, etMidnightUtc } from "../../scripts/changelog/et-dates";

describe("etDayOf", () => {
  test("UTC evening spillover maps back to the Eastern day (EDT)", () => {
    // 02:01 UTC June 11 = 10:01pm ET June 10 — the #1572 merge
    expect(etDayOf(Date.parse("2026-06-11T02:01:00Z"))).toBe("2026-06-10");
    expect(etDayOf(Date.parse("2026-06-11T03:59:59Z"))).toBe("2026-06-10");
    expect(etDayOf(Date.parse("2026-06-11T04:00:00Z"))).toBe("2026-06-11");
  });

  test("EST (winter) uses the -05:00 boundary", () => {
    expect(etDayOf(Date.parse("2026-01-15T04:30:00Z"))).toBe("2026-01-14");
    expect(etDayOf(Date.parse("2026-01-15T05:00:00Z"))).toBe("2026-01-15");
  });

  test("accepts a Date", () => {
    expect(etDayOf(new Date("2026-06-11T12:00:00Z"))).toBe("2026-06-11");
  });
});

describe("etMidnightUtc", () => {
  test("EDT day starts at 04:00Z", () => {
    expect(etMidnightUtc("2026-06-11")).toBe("2026-06-11T04:00:00Z");
  });

  test("EST day starts at 05:00Z", () => {
    expect(etMidnightUtc("2026-01-15")).toBe("2026-01-15T05:00:00Z");
  });

  test("DST transition days: midnight precedes the 2am switch", () => {
    // Spring forward 2026-03-08: midnight is still EST
    expect(etMidnightUtc("2026-03-08")).toBe("2026-03-08T05:00:00Z");
    // Fall back 2026-11-01: midnight is still EDT
    expect(etMidnightUtc("2026-11-01")).toBe("2026-11-01T04:00:00Z");
  });

  test("round-trips with etDayOf at the boundary", () => {
    for (const day of ["2026-06-11", "2026-01-15", "2026-03-08", "2026-11-01"]) {
      const start = Date.parse(etMidnightUtc(day));
      expect(etDayOf(start)).toBe(day);
      expect(etDayOf(start - 1000)).not.toBe(day);
    }
  });
});
