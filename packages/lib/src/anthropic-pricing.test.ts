import { describe, it, expect } from "bun:test";
import { estimateCost, ANTHROPIC_PRICING } from "./anthropic-pricing.js";

describe("estimateCost", () => {
  it("returns null for unknown models", () => {
    expect(estimateCost({ inputTokens: 1000 }, "claude-future-99")).toBeNull();
  });

  it("treats missing token fields as zero", () => {
    const cost = estimateCost({}, "claude-sonnet-4-6");
    expect(cost).toEqual({
      inputUsd: 0,
      cacheWriteUsd: 0,
      cacheReadUsd: 0,
      outputUsd: 0,
      totalUsd: 0,
    });
  });

  it("matches the Sonnet 5.5 list prices on the Claude docs", () => {
    const cost = estimateCost(
      {
        inputTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        outputTokens: 1_000_000,
      },
      "claude-sonnet-5-5",
    );
    expect(cost).toEqual({
      inputUsd: 2,
      cacheWriteUsd: 2.5,
      cacheReadUsd: 0.1,
      outputUsd: 10,
      totalUsd: 14.6,
    });
  });

  it("matches the Sonnet 4.6 list prices on the Anthropic pricing page", () => {
    // 1M of each token type; total should equal sum of the four prices.
    const cost = estimateCost(
      {
        inputTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        outputTokens: 1_000_000,
      },
      "claude-sonnet-4-6",
    );
    expect(cost).toEqual({
      inputUsd: 3,
      cacheWriteUsd: 3.75,
      cacheReadUsd: 0.3,
      outputUsd: 15,
      totalUsd: 22.05,
    });
  });

  it("matches the Haiku 5.5 ≤100K list prices", () => {
    const cost = estimateCost(
      {
        inputTokens: 100_000,
        cacheWriteTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        outputTokens: 1_000_000,
      },
      "claude-haiku-5-5",
      // Cache tokens here are a rate check, not a prompt-length check.
      { longContext: false },
    );
    expect(cost).toEqual({
      inputUsd: 0.01,
      cacheWriteUsd: 0.125,
      cacheReadUsd: 0.01,
      outputUsd: 0.5,
      totalUsd: 0.645,
    });
  });

  it("bills a Haiku 5.5 prompt over 100K tokens entirely at the long-context tier", () => {
    const atCap = estimateCost({ inputTokens: 100_000, outputTokens: 1_000 }, "claude-haiku-5-5");
    expect(atCap).toEqual({
      inputUsd: 0.01,
      cacheWriteUsd: 0,
      cacheReadUsd: 0,
      outputUsd: 0.0005,
      totalUsd: 0.0105,
    });

    const over = estimateCost(
      {
        inputTokens: 90_000,
        cacheReadTokens: 10_000,
        outputTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      },
      "claude-haiku-5-5",
    );
    expect(over).toEqual({
      inputUsd: 0.045,
      cacheWriteUsd: 0.625,
      cacheReadUsd: 0.0005,
      outputUsd: 2.5,
      totalUsd: 3.1705,
    });
  });

  it("keeps a summed multi-request blob on the ≤100K Haiku 5.5 rate", () => {
    const cost = estimateCost(
      { inputTokens: 500_000, outputTokens: 1_000_000 },
      "claude-haiku-5-5",
      { longContext: false, batch: true },
    );
    expect(cost).toEqual({
      inputUsd: 0.025,
      cacheWriteUsd: 0,
      cacheReadUsd: 0,
      outputUsd: 0.25,
      totalUsd: 0.275,
    });
  });

  it("matches the Haiku 4.5 list prices on the Anthropic pricing page", () => {
    const cost = estimateCost(
      {
        inputTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        outputTokens: 1_000_000,
      },
      "claude-haiku-4-5",
    );
    expect(cost).toEqual({
      inputUsd: 1,
      cacheWriteUsd: 1.25,
      cacheReadUsd: 0.1,
      outputUsd: 5,
      totalUsd: 7.35,
    });
  });

  it("reproduces the May 1 Svelte session estimate (~$1.06 on Sonnet)", () => {
    // From the cost investigation: 25 model rounds, cache_creation 138_513,
    // cache_read 1_431_702, input 27, output 7_496. Should land near $1.06.
    const cost = estimateCost(
      {
        inputTokens: 27,
        cacheWriteTokens: 138_513,
        cacheReadTokens: 1_431_702,
        outputTokens: 7_496,
      },
      "claude-sonnet-4-6",
    );
    expect(cost).not.toBeNull();
    expect(cost!.totalUsd).toBeGreaterThan(1.05);
    expect(cost!.totalUsd).toBeLessThan(1.07);
  });

  it("Sonnet 4.6 costs ~3× Haiku 4.5 for equivalent token usage", () => {
    const usage = {
      inputTokens: 100_000,
      cacheWriteTokens: 100_000,
      cacheReadTokens: 1_000_000,
      outputTokens: 10_000,
    };
    const sonnet = estimateCost(usage, "claude-sonnet-4-6")!;
    const haiku = estimateCost(usage, "claude-haiku-4-5")!;
    const ratio = sonnet.totalUsd / haiku.totalUsd;
    expect(ratio).toBeGreaterThan(2.9);
    expect(ratio).toBeLessThan(3.1);
  });

  it("ANTHROPIC_PRICING covers the current Sonnet default and retained older ids", () => {
    expect(ANTHROPIC_PRICING["claude-sonnet-5-5"]).toBeDefined();
    expect(ANTHROPIC_PRICING["claude-sonnet-5"]).toBeDefined();
    expect(ANTHROPIC_PRICING["claude-sonnet-4-6"]).toBeDefined();
    expect(ANTHROPIC_PRICING["claude-haiku-5-5"]).toBeDefined();
    expect(ANTHROPIC_PRICING["claude-haiku-4-5"]).toBeDefined();
  });

  it("coerces malformed token counts (NaN, negative, non-number) to zero", () => {
    const cost = estimateCost(
      {
        inputTokens: Number.NaN,
        cacheWriteTokens: -100,
        cacheReadTokens: undefined,
        outputTokens: "1000" as unknown as number,
      },
      "claude-sonnet-4-6",
    );
    expect(cost).toEqual({
      inputUsd: 0,
      cacheWriteUsd: 0,
      cacheReadUsd: 0,
      outputUsd: 0,
      totalUsd: 0,
    });
  });

  it("halves all four components when options.batch = true", () => {
    const usage = {
      inputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      outputTokens: 1_000_000,
    };
    const live = estimateCost(usage, "claude-haiku-4-5")!;
    const batch = estimateCost(usage, "claude-haiku-4-5", { batch: true })!;
    expect(batch.inputUsd).toBeCloseTo(live.inputUsd / 2);
    expect(batch.cacheWriteUsd).toBeCloseTo(live.cacheWriteUsd / 2);
    expect(batch.cacheReadUsd).toBeCloseTo(live.cacheReadUsd / 2);
    expect(batch.outputUsd).toBeCloseTo(live.outputUsd / 2);
    expect(batch.totalUsd).toBeCloseTo(live.totalUsd / 2);
  });

  it("normalizes dated model snapshots to their base alias", () => {
    // The Anthropic API returns dated snapshots like `claude-haiku-4-5-20251001`
    // even when a session was created against the alias. Both forms must price.
    const usage = { inputTokens: 1_000_000 };
    const dated = estimateCost(usage, "claude-haiku-4-5-20251001");
    const alias = estimateCost(usage, "claude-haiku-4-5");
    expect(dated).not.toBeNull();
    expect(dated).toEqual(alias!);
  });
});
