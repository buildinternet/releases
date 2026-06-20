import { describe, expect, test } from "bun:test";
import { BREAKING_LEVELS, isBreakingLevel } from "./breaking";

describe("BREAKING_LEVELS", () => {
  test("unknown is the first (default) member, ordered low→high risk", () => {
    expect(BREAKING_LEVELS[0]).toBe("unknown");
    expect(BREAKING_LEVELS).toEqual(["unknown", "none", "minor", "major"]);
  });
});

describe("isBreakingLevel", () => {
  test("accepts every enum member", () => {
    for (const level of BREAKING_LEVELS) {
      expect(isBreakingLevel(level)).toBe(true);
    }
  });

  test("rejects anything outside the enum", () => {
    expect(isBreakingLevel("breaking")).toBe(false);
    expect(isBreakingLevel("MAJOR")).toBe(false); // case-sensitive by design
    expect(isBreakingLevel("")).toBe(false);
    expect(isBreakingLevel("yes")).toBe(false);
  });
});
