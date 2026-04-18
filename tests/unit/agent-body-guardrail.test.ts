import { describe, it, expect } from "bun:test";
import {
  buildBodyGuardrail,
  LARGE_BODY_TOKEN_THRESHOLD,
  HUGE_BODY_TOKEN_THRESHOLD,
  DEFAULT_MAX_OUTPUT_TOKENS,
  HUGE_BODY_MAX_OUTPUT_TOKENS,
} from "../../src/adapters/agent.js";

describe("buildBodyGuardrail", () => {
  it("includes the rounded approximate token count", () => {
    const text = buildBodyGuardrail(155_824);
    expect(text).toContain("156,000 tokens");
  });

  it("rounds to the nearest thousand", () => {
    expect(buildBodyGuardrail(50_499)).toContain("50,000 tokens");
    expect(buildBodyGuardrail(50_500)).toContain("51,000 tokens");
  });

  it("instructs the model to focus on most recent entries", () => {
    const text = buildBodyGuardrail(60_000);
    expect(text.toLowerCase()).toContain("most recent");
  });

  it("instructs the model to be concise", () => {
    const text = buildBodyGuardrail(60_000);
    expect(text.toLowerCase()).toContain("concise");
  });

  it("calls out rollup preference for weekly/monthly sources", () => {
    // PostHog-shaped failure mode: per-item entries blow the output budget.
    // The guardrail should hint at preferring rollups when the source uses them.
    const text = buildBodyGuardrail(150_000);
    expect(text.toLowerCase()).toMatch(/rollup|weekly|monthly/);
  });
});

describe("body-size token thresholds", () => {
  it("uses ascending thresholds: large < huge", () => {
    expect(LARGE_BODY_TOKEN_THRESHOLD).toBeLessThan(HUGE_BODY_TOKEN_THRESHOLD);
  });

  it("HUGE bumps output budget over default", () => {
    expect(HUGE_BODY_MAX_OUTPUT_TOKENS).toBeGreaterThan(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it("LARGE threshold is meaningful (not a trivial body)", () => {
    // ~50K tokens corresponds to ~200 KB of body — a body that small
    // shouldn't trigger guardrails or output exhaustion is unlikely
    // to be a real risk.
    expect(LARGE_BODY_TOKEN_THRESHOLD).toBeGreaterThanOrEqual(20_000);
  });
});
