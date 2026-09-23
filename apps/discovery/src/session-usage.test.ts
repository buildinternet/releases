import { describe, expect, it } from "bun:test";

import { estimateCost } from "@releases/lib/anthropic-pricing.js";

import { cacheWriteTokensFrom, parseSessionUsageTokens } from "./session-usage.js";

describe("cacheWriteTokensFrom", () => {
  it("sums the nested managed-agents cache_creation buckets (the real session shape)", () => {
    // Shape observed in production session-usage logs — cache-creation is
    // nested by lifetime, not the flat Messages-API field.
    const usage = {
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 36401 },
      cache_read_input_tokens: 0,
      input_tokens: 16,
      output_tokens: 449,
    };
    expect(cacheWriteTokensFrom(usage)).toBe(36401);
  });

  it("adds both lifetime buckets when both are present", () => {
    const usage = {
      cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 500 },
    };
    expect(cacheWriteTokensFrom(usage)).toBe(1500);
  });

  it("falls back to the flat cache_creation_input_tokens field", () => {
    expect(cacheWriteTokensFrom({ cache_creation_input_tokens: 4200 })).toBe(4200);
  });

  it("returns undefined when no cache-creation field is present", () => {
    expect(cacheWriteTokensFrom({ input_tokens: 10 })).toBeUndefined();
    expect(cacheWriteTokensFrom(undefined)).toBeUndefined();
  });
});

describe("parseSessionUsageTokens", () => {
  it("extracts all four buckets from a nested session usage object", () => {
    const usage = {
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 19273 },
      cache_read_input_tokens: 18719,
      input_tokens: 17,
      output_tokens: 526,
    };
    expect(parseSessionUsageTokens(usage)).toEqual({
      inputTokens: 17,
      outputTokens: 526,
      cacheWriteTokens: 19273,
      cacheReadTokens: 18719,
    });
  });

  it("regression: estimateCost includes cache-creation cost (was previously dropped ~7x)", () => {
    // The exact bug: a single-agent worker session whose cost is dominated by
    // cache-creation of the static prompt/skills/playbook. Before the fix,
    // cacheWriteTokens parsed as undefined and this session estimated at only
    // the ~output-token cost.
    const usage = {
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 36401 },
      cache_read_input_tokens: 0,
      input_tokens: 16,
      output_tokens: 449,
    };
    const tokens = parseSessionUsageTokens(usage);
    const cost = estimateCost(tokens, "claude-haiku-4-5");
    // Haiku cache-write $1.25/M * 36401 = $0.0455; output $5/M * 449 = $0.00225.
    expect(cost?.cacheWriteUsd ?? 0).toBeCloseTo(0.0455, 4);
    expect(cost?.totalUsd ?? 0).toBeGreaterThan(0.045);
  });
});
