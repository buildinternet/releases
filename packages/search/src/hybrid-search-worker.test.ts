import { test, expect } from "bun:test";
import { recencyBoost } from "./hybrid-search-worker.js";

const DAY_MS = 86_400_000;
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

// Pure-function tests pin the Option B taper from #1045. The numbers
// here mirror the multiplier table in docs/architecture/semantic-search.md
// so if either drifts, both fail.

test("recencyBoost: age <= 30d returns full peak boost", () => {
  expect(recencyBoost(0, 1.5, 1.0)).toBe(1.5);
  expect(recencyBoost(14 * DAY_MS, 1.5, 1.0)).toBe(1.5);
  expect(recencyBoost(30 * DAY_MS, 1.5, 1.0)).toBe(1.5);
});

test("recencyBoost: 30d < age < 90d tapers linearly between peak and knee", () => {
  // Pure Option B: peak 1.5, knee 1.0, midpoint should land at 1.25.
  expect(close(recencyBoost(60 * DAY_MS, 1.5, 1.0), 1.25)).toBe(true);
  // 45d is 25% through the [30d, 90d] window — boost = 1.5 - 0.5 * 0.25 = 1.375.
  expect(close(recencyBoost(45 * DAY_MS, 1.5, 1.0), 1.375)).toBe(true);
  // Knee endpoint with the default boost90d (1.2): smooth ramp from 1.5 → 1.2.
  expect(close(recencyBoost(60 * DAY_MS, 1.5, 1.2), 1.35)).toBe(true);
});

test("recencyBoost: age >= 90d collapses to 1.0 regardless of inputs", () => {
  expect(recencyBoost(90 * DAY_MS, 1.5, 1.2)).toBe(1);
  expect(recencyBoost(180 * DAY_MS, 1.5, 1.2)).toBe(1);
  expect(recencyBoost(365 * DAY_MS, 5.0, 5.0)).toBe(1);
});

test("recencyBoost: both inputs at 1.0 disables tiered behavior", () => {
  // Floor case — the env-var floor pins MIN_BOOST = 1.0 so this is the
  // narrowest legal config. Result must be 1.0 across the whole curve so
  // the caller falls back to pure decay.
  for (const ageDays of [0, 14, 30, 60, 90, 365]) {
    expect(recencyBoost(ageDays * DAY_MS, 1, 1)).toBe(1);
  }
});
