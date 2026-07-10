import { describe, expect, test } from "bun:test";
import { importanceChipLabel } from "./importance-chip";

// Score → label/visibility mapping for the importance chip. The chip must
// render NOTHING below 4 — 1–3 (housekeeping/routine/notable) are the bulk
// of the feed, so a chip there would be noise; only 4 ("Major") and 5
// ("Landmark") earn a chip.
describe("importanceChipLabel", () => {
  test("5 renders 'Landmark'", () => {
    expect(importanceChipLabel(5)).toBe("Landmark");
  });

  test("4 renders 'Major'", () => {
    expect(importanceChipLabel(4)).toBe("Major");
  });

  test("1, 2, 3 render nothing", () => {
    expect(importanceChipLabel(1)).toBeNull();
    expect(importanceChipLabel(2)).toBeNull();
    expect(importanceChipLabel(3)).toBeNull();
  });

  test("null / undefined render nothing", () => {
    expect(importanceChipLabel(null)).toBeNull();
    expect(importanceChipLabel(undefined)).toBeNull();
  });
});
