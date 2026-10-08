import { describe, expect, test } from "bun:test";
import {
  rectToPercent,
  squarify,
  TREEMAP_HEIGHT,
  TREEMAP_WIDTH,
  type Rect,
} from "./treemap-layout";

const area = (r: Rect) => r.w * r.h;
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w - 1e-6 &&
  b.x < a.x + a.w - 1e-6 &&
  a.y < b.y + b.h - 1e-6 &&
  b.y < a.y + a.h - 1e-6;

describe("squarify", () => {
  const values = [11.5, 7.6, 5.1, 2.3, 1.1];
  const rects = squarify(values);

  test("tiles fill the box exactly", () => {
    const total = rects.reduce((sum, r) => sum + area(r), 0);
    expect(total).toBeCloseTo(TREEMAP_WIDTH * TREEMAP_HEIGHT, 3);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(-1e-6);
      expect(r.y).toBeGreaterThanOrEqual(-1e-6);
      expect(r.x + r.w).toBeLessThanOrEqual(TREEMAP_WIDTH + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(TREEMAP_HEIGHT + 1e-6);
    }
  });

  test("tiles never overlap", () => {
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i], rects[j])).toBe(false);
    }
  });

  test("areas are proportional to values", () => {
    const sum = values.reduce((a, b) => a + b, 0);
    rects.forEach((r, i) => {
      expect(area(r) / (TREEMAP_WIDTH * TREEMAP_HEIGHT)).toBeCloseTo(values[i] / sum, 6);
    });
  });

  test("zero values get zero-size rects; all-zero input lays out nothing", () => {
    const out = squarify([3, 0, 1]);
    expect(area(out[1])).toBe(0);
    expect(area(out[0]) + area(out[2])).toBeCloseTo(TREEMAP_WIDTH * TREEMAP_HEIGHT, 3);
    expect(squarify([0, 0]).every((r) => area(r) === 0)).toBe(true);
  });
});

describe("rectToPercent", () => {
  test("insets by the gap and converts to percentages", () => {
    expect(rectToPercent({ x: 0, y: 0, w: TREEMAP_WIDTH, h: TREEMAP_HEIGHT }, 0)).toEqual({
      left: "0.000%",
      top: "0.000%",
      width: "100.000%",
      height: "100.000%",
    });
    const p = rectToPercent({ x: 356, y: 150, w: 356, h: 150 }, 2);
    expect(p.left).toBe(`${((358 / 712) * 100).toFixed(3)}%`);
    expect(p.height).toBe(`${((146 / 300) * 100).toFixed(3)}%`);
  });
});
