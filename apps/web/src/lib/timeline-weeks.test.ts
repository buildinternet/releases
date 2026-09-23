import { describe, expect, test } from "bun:test";
import { weekBoundaries } from "./timeline-weeks";

describe("weekBoundaries", () => {
  test("marks the newest day of each ET week (Mon-start)", () => {
    const days = ["2026-09-22", "2026-09-21", "2026-09-20", "2026-09-14", "2026-09-13"];
    expect([...weekBoundaries(days)]).toEqual([
      ["2026-09-22", "2026-09-21"],
      ["2026-09-20", "2026-09-14"],
      ["2026-09-13", "2026-09-07"],
    ]);
  });
  test("ignores non-date keys", () => {
    expect([...weekBoundaries(["unknown"])]).toEqual([]);
  });
});
