/**
 * Anthropic list-price-based cost estimation for managed-agent sessions.
 *
 * Prices are USD per 1M tokens, as published on https://www.anthropic.com/pricing.
 * These figures are list prices — the actual billed amount can differ via volume
 * discounts, AI Gateway pass-through, or batch tier. Always label downstream
 * surfaces as "estimated" so consumers don't treat this as authoritative billing.
 */

export interface ModelPricing {
  /** Per-1M tokens, $USD. The ≤ threshold tier when `longContext` is set. */
  inputUsdPerMillion: number;
  cacheWrite5mUsdPerMillion: number;
  cacheReadUsdPerMillion: number;
  outputUsdPerMillion: number;
  /**
   * Higher rates for a single prompt over `thresholdTokens`. Anthropic bills
   * the whole request (input, output, and cache) at this tier — not only the
   * tokens above the line. Prompt length is input + cache write + cache read.
   */
  longContext?: {
    thresholdTokens: number;
    inputUsdPerMillion: number;
    cacheWrite5mUsdPerMillion: number;
    cacheReadUsdPerMillion: number;
    outputUsdPerMillion: number;
  };
}

/**
 * Pricing keyed by Anthropic API model id. Add new models here when they ship —
 * unknown models fall through to a `null` estimate (UI should hide the dollar
 * figure but keep token counts visible).
 */
export const ANTHROPIC_PRICING: Record<string, ModelPricing> = {
  // Published list price. https://platform.claude.com/docs/en/models/sonnet-5-5/overview
  // Cache read is 5% of input ($0.10/M) as of the 2026-10 pricing update.
  "claude-sonnet-5-5": {
    inputUsdPerMillion: 2,
    cacheWrite5mUsdPerMillion: 2.5,
    cacheReadUsdPerMillion: 0.1,
    outputUsdPerMillion: 10,
  },
  // Retained: historical sessions estimate cost against the model they ran on.
  // Standard list price ($3/$15). An introductory $2/$10 per-MTok promo ran
  // through 2026-08-31; these are list-price estimates (see file header).
  "claude-sonnet-5": {
    inputUsdPerMillion: 3,
    cacheWrite5mUsdPerMillion: 3.75,
    cacheReadUsdPerMillion: 0.3,
    outputUsdPerMillion: 15,
  },
  // Retained: still served, and historical managed-agent sessions estimate cost
  // against the model they actually ran on.
  "claude-sonnet-4-6": {
    inputUsdPerMillion: 3,
    cacheWrite5mUsdPerMillion: 3.75,
    cacheReadUsdPerMillion: 0.3,
    outputUsdPerMillion: 15,
  },
  // ≤100K prompt tier. A single prompt over 100K tokens is billed entirely at
  // `longContext` (5×). https://platform.claude.com/docs/en/models/haiku-5-5/overview
  // Callers that sum many sub-threshold requests into one usage blob must pass
  // `longContext: false` — see estimateCost.
  "claude-haiku-5-5": {
    inputUsdPerMillion: 0.1,
    cacheWrite5mUsdPerMillion: 0.125,
    cacheReadUsdPerMillion: 0.01,
    outputUsdPerMillion: 0.5,
    longContext: {
      thresholdTokens: 100_000,
      inputUsdPerMillion: 0.5,
      cacheWrite5mUsdPerMillion: 0.625,
      cacheReadUsdPerMillion: 0.05,
      outputUsdPerMillion: 2.5,
    },
  },
  // Retained: historical sessions and batch rows still estimate against the
  // model they ran on. Haiku 5.5 does not use a dated snapshot id.
  "claude-haiku-4-5": {
    inputUsdPerMillion: 1,
    cacheWrite5mUsdPerMillion: 1.25,
    cacheReadUsdPerMillion: 0.1,
    outputUsdPerMillion: 5,
  },
};

export interface TokenUsage {
  inputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
}

export interface CostEstimate {
  inputUsd: number;
  cacheWriteUsd: number;
  cacheReadUsd: number;
  outputUsd: number;
  totalUsd: number;
}

/**
 * Strip the trailing dated snapshot suffix from a model id so the pricing
 * lookup matches both the alias (`claude-haiku-4-5`) and the dated form
 * (`claude-haiku-4-5-20251001`) the API returns. New variants (`-thinking`,
 * speed tiers, etc.) will need explicit entries in `ANTHROPIC_PRICING` rather
 * than this normalizer.
 */
function normalizeModelId(model: string): string {
  // Match `-YYYYMMDD` at end of string and remove it.
  return model.replace(/-\d{8}$/, "");
}

/**
 * Coerce a possibly-undefined / NaN / negative token count to a finite
 * non-negative number. Token counts come from upstream JSON and aren't
 * type-guaranteed here — without this guard a single bad field would
 * produce NaN that propagates through every cost field.
 */
function sanitizeTokenCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

export interface EstimateCostOptions {
  /** Apply Anthropic's 50% Message Batches discount to all four cost components. */
  batch?: boolean;
  /**
   * Haiku 5.5 charges a higher rate on the whole request when that request's
   * prompt exceeds 100K tokens. Default applies the tier when THIS usage blob's
   * prompt (input + cache write + cache read) is over the threshold — correct
   * for one API call, wrong when the blob sums many sub-threshold calls (a
   * batch budget guard, a per-source rollup). Pass `false` for those rollups
   * so they stay on the ≤100K rate.
   */
  longContext?: boolean;
}

/** Message Batches API discount on input + output (incl. cache). */
const BATCH_MULTIPLIER = 0.5;

/** Pick the long-context rate card when this blob is one over-threshold prompt. */
function resolveTier(
  price: ModelPricing,
  promptTokens: number,
  allowLongContext: boolean,
): ModelPricing {
  const long = price.longContext;
  if (!allowLongContext || !long || promptTokens <= long.thresholdTokens) return price;
  return {
    inputUsdPerMillion: long.inputUsdPerMillion,
    cacheWrite5mUsdPerMillion: long.cacheWrite5mUsdPerMillion,
    cacheReadUsdPerMillion: long.cacheReadUsdPerMillion,
    outputUsdPerMillion: long.outputUsdPerMillion,
  };
}

/**
 * Compute an estimated USD cost from token usage + model id. Returns `null`
 * if the model isn't in the pricing table — callers should fall back to
 * showing token counts only. Missing token fields default to 0, which is the
 * right answer for sessions where prompt-cache wasn't used.
 */
export function estimateCost(
  usage: TokenUsage,
  model: string,
  options: EstimateCostOptions = {},
): CostEstimate | null {
  const listed = ANTHROPIC_PRICING[normalizeModelId(model)];
  if (!listed) return null;
  const multiplier = options.batch ? BATCH_MULTIPLIER : 1;
  const sanitizedInputTokens = sanitizeTokenCount(usage.inputTokens);
  const sanitizedCacheWriteTokens = sanitizeTokenCount(usage.cacheWriteTokens);
  const sanitizedCacheReadTokens = sanitizeTokenCount(usage.cacheReadTokens);
  const sanitizedOutputTokens = sanitizeTokenCount(usage.outputTokens);
  const promptTokens = sanitizedInputTokens + sanitizedCacheWriteTokens + sanitizedCacheReadTokens;
  const price = resolveTier(listed, promptTokens, options.longContext !== false);
  const inputUsd = ((sanitizedInputTokens * price.inputUsdPerMillion) / 1_000_000) * multiplier;
  const cacheWriteUsd =
    ((sanitizedCacheWriteTokens * price.cacheWrite5mUsdPerMillion) / 1_000_000) * multiplier;
  const cacheReadUsd =
    ((sanitizedCacheReadTokens * price.cacheReadUsdPerMillion) / 1_000_000) * multiplier;
  const outputUsd = ((sanitizedOutputTokens * price.outputUsdPerMillion) / 1_000_000) * multiplier;
  return {
    inputUsd,
    cacheWriteUsd,
    cacheReadUsd,
    outputUsd,
    totalUsd: inputUsd + cacheWriteUsd + cacheReadUsd + outputUsd,
  };
}
