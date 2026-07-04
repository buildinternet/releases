/**
 * Token-usage parsing for Anthropic Managed Agents session/thread usage objects.
 *
 * Kept as a pure module (no SDK, no DO state) so the shape-sensitive parse can
 * be unit-tested. The managed-agents usage object nests cache-creation by
 * lifetime bucket — `cache_creation: { ephemeral_5m_input_tokens,
 * ephemeral_1h_input_tokens }` — which is NOT the flat
 * `cache_creation_input_tokens` field the Messages API returns. Reading only
 * the flat field silently dropped the dominant cache-creation cost (~84% of a
 * routine `update` session) from single-agent worker cost estimates.
 */

/** Normalized token counts fed to `estimateCost`. Undefined = field absent. */
export interface SessionUsageTokens {
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

interface NestedCacheCreation {
  ephemeral_5m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
}

/**
 * Total cache-creation (write) tokens from a managed-agents usage object.
 * Prefers the nested `cache_creation` buckets (summing 5m + 1h lifetimes),
 * falling back to the flat `cache_creation_input_tokens` field. Returns
 * `undefined` when neither is present so absent usage stays absent rather than
 * being coerced to 0.
 */
export function cacheWriteTokensFrom(
  usage: Record<string, unknown> | undefined,
): number | undefined {
  if (!usage) return undefined;
  const nested = usage.cache_creation as NestedCacheCreation | undefined;
  if (nested !== undefined) {
    return (nested.ephemeral_5m_input_tokens ?? 0) + (nested.ephemeral_1h_input_tokens ?? 0);
  }
  return usage.cache_creation_input_tokens as number | undefined;
}

/** Parse the four token buckets from a session- or thread-level usage object. */
export function parseSessionUsageTokens(
  usage: Record<string, unknown> | undefined,
): SessionUsageTokens {
  return {
    inputTokens: usage?.input_tokens as number | undefined,
    outputTokens: usage?.output_tokens as number | undefined,
    cacheWriteTokens: cacheWriteTokensFrom(usage),
    cacheReadTokens: usage?.cache_read_input_tokens as number | undefined,
  };
}
