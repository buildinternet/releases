import { describe, expect, test } from "bun:test";
import { nextTabIndex } from "./terminal-tab-nav";

describe("nextTabIndex", () => {
  test("ArrowRight advances", () => {
    expect(nextTabIndex(0, "ArrowRight", 3)).toBe(1);
  });
  test("ArrowRight wraps past the end", () => {
    expect(nextTabIndex(2, "ArrowRight", 3)).toBe(0);
  });
  test("ArrowLeft retreats", () => {
    expect(nextTabIndex(1, "ArrowLeft", 3)).toBe(0);
  });
  test("ArrowLeft wraps before the start", () => {
    expect(nextTabIndex(0, "ArrowLeft", 3)).toBe(2);
  });
  test("Home jumps to first", () => {
    expect(nextTabIndex(2, "Home", 3)).toBe(0);
  });
  test("End jumps to last", () => {
    expect(nextTabIndex(0, "End", 3)).toBe(2);
  });
  test("non-nav keys return null", () => {
    expect(nextTabIndex(0, "Enter", 3)).toBeNull();
    expect(nextTabIndex(0, " ", 3)).toBeNull();
  });
  test("guards an empty tablist", () => {
    expect(nextTabIndex(0, "ArrowRight", 0)).toBeNull();
  });
});
