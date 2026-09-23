import { describe, expect, test } from "bun:test";
import { weekOfLabel, weekRangeLabel, shortMonthDayLabel, weekDividerLabel } from "./digest-format";

describe("weekOfLabel", () => {
  test("labels the ET Monday", () => {
    expect(weekOfLabel("2026-09-14")).toBe("Week of September 14, 2026");
  });
});

describe("shortMonthDayLabel", () => {
  test("short month + numeric day, UTC", () => {
    expect(shortMonthDayLabel("2026-09-14")).toBe("Sep 14");
    expect(shortMonthDayLabel("2026-01-01")).toBe("Jan 1");
  });
});

describe("weekDividerLabel", () => {
  test("prefixes the short label with 'Week of'", () => {
    expect(weekDividerLabel("2026-09-14")).toBe("Week of Sep 14");
  });
});

describe("weekRangeLabel", () => {
  test("same-month week collapses the month", () => {
    expect(weekRangeLabel("2026-09-14")).toBe("Sep 14 – 20, 2026");
  });

  test("cross-month week names both months", () => {
    expect(weekRangeLabel("2026-08-31")).toBe("Aug 31 – Sep 6, 2026");
  });

  test("cross-year week names both years", () => {
    expect(weekRangeLabel("2026-12-28")).toBe("Dec 28, 2026 – Jan 3, 2027");
  });

  test("year: false drops the year", () => {
    expect(weekRangeLabel("2026-09-14", { year: false })).toBe("Sep 14 – 20");
    expect(weekRangeLabel("2026-08-31", { year: false })).toBe("Aug 31 – Sep 6");
    expect(weekRangeLabel("2026-12-28", { year: false })).toBe("Dec 28 – Jan 3");
  });
});
