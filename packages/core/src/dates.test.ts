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
