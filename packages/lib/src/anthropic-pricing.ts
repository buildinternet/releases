/**
 * Anthropic list-price-based cost estimation for managed-agent sessions.
 *
 * Prices are USD per 1M tokens, as published on https://www.anthropic.com/pricing.
 * These figures are list prices — the actual billed amount can differ via volume
 * discounts, AI Gateway pass-through, or batch tier. Always label downstream
 * surfaces as "estimated" so consumers don't treat this as authoritative billing.
 */

export interface ModelPricing {
  /** Per-1M tokens, $USD. */
  inputUsdPerMillion: number;
  cacheWrite5mUsdPerMillion: number;
  cacheReadUsdPerMillion: number;
  outputUsdPerMillion: number;
}

/**
 * Pricing keyed by Anthropic API model id. Add new models here when they ship —
 * unknown models fall through to a `null` estimate (UI should hide the dollar
 * figure but keep token counts visible).
 */
export const ANTHROPIC_PRICING: Record<string, ModelPricing> = {
  // Standard list price ($3/$15). An introductory $2/$10 per-MTok promo runs
  // through 2026-08-31, but these are list-price estimates (see file header), so
  // the sticker price is the stable, non-expiring figure to key cost off of.
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
}

/** Message Batches API discount on input + output (incl. cache). */
const BATCH_MULTIPLIER = 0.5;

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
  const price = ANTHROPIC_PRICING[normalizeModelId(model)];
  if (!price) return null;
  const multiplier = options.batch ? BATCH_MULTIPLIER : 1;
  const sanitizedInputTokens = sanitizeTokenCount(usage.inputTokens);
  const sanitizedCacheWriteTokens = sanitizeTokenCount(usage.cacheWriteTokens);
  const sanitizedCacheReadTokens = sanitizeTokenCount(usage.cacheReadTokens);
  const sanitizedOutputTokens = sanitizeTokenCount(usage.outputTokens);
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
