import { describe, it, expect } from "bun:test";
import { isImportanceScore, isRoutineAppRelease } from "./importance.js";

describe("isImportanceScore", () => {
  it("accepts 1–5 integers only", () => {
    expect(isImportanceScore(1)).toBe(true);
    expect(isImportanceScore(5)).toBe(true);
    expect(isImportanceScore(0)).toBe(false);
    expect(isImportanceScore(6)).toBe(false);
    expect(isImportanceScore(3.5)).toBe(false);
  });
});

describe("isRoutineAppRelease (cross-promo gate)", () => {
  it("flags a low-importance / unscored app release as routine (skip it)", () => {
    expect(isRoutineAppRelease(true, 1)).toBe(true);
    expect(isRoutineAppRelease(true, 3)).toBe(true);
    expect(isRoutineAppRelease(true, null)).toBe(true);
    expect(isRoutineAppRelease(true, undefined)).toBe(true);
  });

  it("keeps a flame-threshold app release (4–5)", () => {
    expect(isRoutineAppRelease(true, 4)).toBe(false);
    expect(isRoutineAppRelease(true, 5)).toBe(false);
  });

  it("never treats a non-app release as routine, whatever its importance", () => {
    expect(isRoutineAppRelease(false, 1)).toBe(false);
    expect(isRoutineAppRelease(false, null)).toBe(false);
    expect(isRoutineAppRelease(false, undefined)).toBe(false);
  });
});
