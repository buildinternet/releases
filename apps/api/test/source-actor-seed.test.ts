import { describe, it, expect } from "bun:test";
import { seedJitterMs, SEED_JITTER_WINDOW_MS } from "../src/lib/source-actor-seed.js";

describe("seedJitterMs", () => {
  it("is within the window and deterministic", () => {
    const a = seedJitterMs("src_a");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(SEED_JITTER_WINDOW_MS);
    expect(seedJitterMs("src_a")).toBe(a);
  });

  it("spreads distinct ids across the window", () => {
    const jitters = Array.from({ length: 50 }, (_, i) => seedJitterMs(`src_${i}`));
    // Not all collapsed onto one slot — the whole point of seed jitter.
    expect(new Set(jitters).size).toBeGreaterThan(10);
  });

  it("returns 0 for a zero window", () => {
    expect(seedJitterMs("src_a", 0)).toBe(0);
    expect(seedJitterMs("src_a", -1)).toBe(0);
  });

  it("respects a custom window", () => {
    for (let i = 0; i < 100; i++) {
      const j = seedJitterMs(`src_${i}`, 1000);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThan(1000);
    }
  });
});
