import { describe, it, expect } from "bun:test";
import {
  isSourceActorManaged,
  parseCohortPct,
  seedJitterMs,
  SEED_JITTER_WINDOW_MS,
} from "../src/lib/source-actor-cohort.js";

describe("parseCohortPct", () => {
  it("defaults to 0 for unset / NaN", () => {
    expect(parseCohortPct(undefined)).toBe(0);
    expect(parseCohortPct("")).toBe(0);
    expect(parseCohortPct("abc")).toBe(0);
  });
  it("clamps to [0, 100]", () => {
    expect(parseCohortPct("-5")).toBe(0);
    expect(parseCohortPct("50")).toBe(50);
    expect(parseCohortPct("100")).toBe(100);
    expect(parseCohortPct("250")).toBe(100);
  });
});

describe("isSourceActorManaged", () => {
  it("is false unless flag on AND binding present AND pct > 0", () => {
    expect(isSourceActorManaged("src_a", false, 100, true)).toBe(false); // flag off
    expect(isSourceActorManaged("src_a", true, 100, false)).toBe(false); // no binding
    expect(isSourceActorManaged("src_a", true, 0, true)).toBe(false); // pct 0
  });

  it("is true for all sources at pct 100", () => {
    expect(isSourceActorManaged("src_a", true, 100, true)).toBe(true);
    expect(isSourceActorManaged("src_zzz", true, 100, true)).toBe(true);
  });

  it("is deterministic per source id", () => {
    const a1 = isSourceActorManaged("src_stable", true, 37, true);
    const a2 = isSourceActorManaged("src_stable", true, 37, true);
    expect(a1).toBe(a2);
  });

  it("widens monotonically with pct (a managed source stays managed as pct rises)", () => {
    // Find a source managed at 10% via a bounded search (independent of any
    // specific FNV outputs), then assert it stays managed at 50% and 90%.
    const id = Array.from({ length: 1000 }, (_, i) => `src_${i}`).find((s) =>
      isSourceActorManaged(s, true, 10, true),
    );
    expect(id).toBeDefined();
    expect(isSourceActorManaged(id!, true, 50, true)).toBe(true);
    expect(isSourceActorManaged(id!, true, 90, true)).toBe(true);
  });

  it("roughly tracks the requested percentage across many ids", () => {
    const N = 2000;
    let managed = 0;
    for (let i = 0; i < N; i++) {
      if (isSourceActorManaged(`src_${i}`, true, 25, true)) managed++;
    }
    const ratio = managed / N;
    expect(ratio).toBeGreaterThan(0.18);
    expect(ratio).toBeLessThan(0.32);
  });
});

describe("seedJitterMs", () => {
  it("is within the window and deterministic", () => {
    const a = seedJitterMs("src_a");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(SEED_JITTER_WINDOW_MS);
    expect(seedJitterMs("src_a")).toBe(a);
  });
  it("returns 0 for a zero window", () => {
    expect(seedJitterMs("src_a", 0)).toBe(0);
  });
});
