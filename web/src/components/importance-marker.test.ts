import { describe, expect, test } from "bun:test";
import { importanceMarkerLabel } from "./importance-marker";

// Score → label/visibility mapping for the importance dot. The marker must
// render NOTHING below 4 — 1–3 (housekeeping/routine/notable) are the bulk
// of the feed, so a cue there would be noise; only 4 (major) and 5
// (landmark) earn the dot.
describe("importanceMarkerLabel", () => {
  test("5 renders the landmark label", () => {
    expect(importanceMarkerLabel(5)).toContain("5/5");
    expect(importanceMarkerLabel(5)).toContain("landmark");
  });

  test("4 renders the major label", () => {
    expect(importanceMarkerLabel(4)).toContain("4/5");
    expect(importanceMarkerLabel(4)).toContain("major");
  });

  test("1, 2, 3 render nothing", () => {
    expect(importanceMarkerLabel(1)).toBeNull();
    expect(importanceMarkerLabel(2)).toBeNull();
    expect(importanceMarkerLabel(3)).toBeNull();
  });

  test("null / undefined render nothing", () => {
    expect(importanceMarkerLabel(null)).toBeNull();
    expect(importanceMarkerLabel(undefined)).toBeNull();
  });
});
