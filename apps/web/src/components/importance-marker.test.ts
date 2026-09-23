import { describe, expect, test } from "bun:test";
import { importanceMarkerCopy, importanceMarkerLabel } from "./importance-marker";

// Only 4 (major) and 5 (landmark) earn the flame; 1–3 stay silent.
describe("importanceMarkerCopy", () => {
  test("5 renders the landmark label + description", () => {
    const copy = importanceMarkerCopy(5);
    expect(copy?.label).toContain("5/5");
    expect(copy?.label.toLowerCase()).toContain("landmark");
    expect(copy?.description.toLowerCase()).toContain("ai-scored");
  });

  test("4 renders the major label + description", () => {
    const copy = importanceMarkerCopy(4);
    expect(copy?.label).toContain("4/5");
    expect(copy?.label.toLowerCase()).toContain("major");
    expect(copy?.description.toLowerCase()).toContain("ai-scored");
  });

  test("1, 2, 3 render nothing", () => {
    expect(importanceMarkerCopy(1)).toBeNull();
    expect(importanceMarkerCopy(2)).toBeNull();
    expect(importanceMarkerCopy(3)).toBeNull();
  });

  test("null / undefined render nothing", () => {
    expect(importanceMarkerCopy(null)).toBeNull();
    expect(importanceMarkerCopy(undefined)).toBeNull();
  });
});

describe("importanceMarkerLabel", () => {
  test("delegates to copy.label", () => {
    expect(importanceMarkerLabel(5)).toBe(importanceMarkerCopy(5)!.label);
    expect(importanceMarkerLabel(4)).toBe(importanceMarkerCopy(4)!.label);
    expect(importanceMarkerLabel(3)).toBeNull();
  });
});
