import { describe, it, expect } from "bun:test";
import { jitterMsForSource } from "../../workers/api/src/workflows/poll-and-fetch";

describe("jitterMsForSource", () => {
  it("returns a value within [0, windowMs)", () => {
    const window = 300_000;
    for (let i = 0; i < 50; i++) {
      const v = jitterMsForSource(`src_${i.toString(36)}`, window);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(window);
    }
  });

  it("returns 0 when windowMs is 0 or negative (kill switch)", () => {
    expect(jitterMsForSource("src_x", 0)).toBe(0);
    expect(jitterMsForSource("src_x", -1)).toBe(0);
  });

  it("is deterministic — same id always yields the same slot", () => {
    const id = "src_pQ3ApJmYvRAadIqpo8FYD";
    const a = jitterMsForSource(id, 300_000);
    const b = jitterMsForSource(id, 300_000);
    expect(a).toBe(b);
  });

  it("spreads — different ids land in different slots", () => {
    const window = 300_000;
    const slots = new Set<number>();
    for (let i = 0; i < 100; i++) {
      slots.add(jitterMsForSource(`src_${i}`, window));
    }
    // FNV-1a is well-distributed; expect almost-unique slots.
    expect(slots.size).toBeGreaterThan(90);
  });

  it("approximates a uniform distribution across the window", () => {
    const window = 300_000;
    const bucketCount = 10;
    const bucketSize = window / bucketCount;
    const counts: number[] = Array.from({ length: bucketCount }, () => 0);
    const sampleSize = 1000;
    for (let i = 0; i < sampleSize; i++) {
      const slot = jitterMsForSource(`src_${i.toString(36)}_x`, window);
      counts[Math.floor(slot / bucketSize)]++;
    }
    // Each bucket should hold roughly sampleSize / bucketCount = 100; allow
    // a generous 2x band so this isn't a flaky statistical test.
    for (const c of counts) {
      expect(c).toBeGreaterThan(50);
      expect(c).toBeLessThan(200);
    }
  });
});
