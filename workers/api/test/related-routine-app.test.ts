import { describe, it, expect } from "bun:test";
import { isRoutineAppRelease } from "../src/related-ranking";

describe("isRoutineAppRelease (global rail cross-promo gate)", () => {
  it("drops a low-importance appstore release (1–3)", () => {
    expect(isRoutineAppRelease("appstore", 1)).toBe(true);
    expect(isRoutineAppRelease("appstore", 2)).toBe(true);
    expect(isRoutineAppRelease("appstore", 3)).toBe(true);
  });

  it("drops an unscored appstore release (null/undefined folds below the floor)", () => {
    expect(isRoutineAppRelease("appstore", null)).toBe(true);
    expect(isRoutineAppRelease("appstore", undefined)).toBe(true);
  });

  it("keeps a flame-threshold appstore release (4–5)", () => {
    expect(isRoutineAppRelease("appstore", 4)).toBe(false);
    expect(isRoutineAppRelease("appstore", 5)).toBe(false);
  });

  it("never filters non-appstore releases regardless of importance", () => {
    expect(isRoutineAppRelease("github", 1)).toBe(false);
    expect(isRoutineAppRelease("feed", null)).toBe(false);
    expect(isRoutineAppRelease("scrape", 2)).toBe(false);
    expect(isRoutineAppRelease("agent", undefined)).toBe(false);
  });
});
