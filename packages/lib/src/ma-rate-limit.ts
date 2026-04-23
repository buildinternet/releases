/**
 * Classifier for 429 rate-limit errors thrown by `@anthropic-ai/sdk` when
 * driving managed-agents sessions. Kept in `@releases/lib` rather than the
 * discovery worker so tests run against the same physical `@anthropic-ai/sdk`
 * copy that the production code imports — the discovery worker is not a Bun
 * workspace, so its `node_modules/@anthropic-ai/sdk` would otherwise be a
 * distinct install from the root-hoisted one, and `instanceof RateLimitError`
 * would split across class identities.
 */

import { RateLimitError } from "@anthropic-ai/sdk";
import type { ErrorType } from "@anthropic-ai/sdk/resources/shared";

const MA_RATE_LIMIT_DEFAULT_RETRY_AFTER_S = 60;
const MA_RATE_LIMIT_JITTER_MAX_S = 10;

export interface MaRateLimitClassification {
  isRateLimit: boolean;
  errorType?: ErrorType;
  /** Retry-After delay in milliseconds (includes jitter). */
  retryAfterMs: number;
}

/**
 * Classify an error thrown by the Anthropic SDK as a 429 rate-limit error.
 * Reads `Retry-After` from response headers when present; falls back to a 60s
 * default plus jitter. `getJitterMs` is injectable for deterministic tests.
 */
export function classifyMaRateLimitError(
  err: unknown,
  opts: { getJitterMs?: () => number } = {},
): MaRateLimitClassification {
  if (!(err instanceof RateLimitError)) return { isRateLimit: false, retryAfterMs: 0 };

  let retryAfterS = MA_RATE_LIMIT_DEFAULT_RETRY_AFTER_S;
  const raw = err.headers.get("retry-after");
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) retryAfterS = parsed;
  }

  const getJitterMs = opts.getJitterMs ?? (() => Math.random() * MA_RATE_LIMIT_JITTER_MAX_S * 1000);

  return {
    isRateLimit: true,
    errorType: err.type ?? undefined,
    retryAfterMs: retryAfterS * 1000 + getJitterMs(),
  };
}

export function buildMaRateLimitErrorMessage(
  classification: MaRateLimitClassification,
  retryCount: number,
): string {
  const typeNote = classification.errorType ? ` (${classification.errorType})` : "";
  const retryAfterS = Math.round(classification.retryAfterMs / 1000);
  return `Anthropic managed-agents rate limit${typeNote}. Retry after ${retryAfterS}s. Session was retried ${retryCount} time(s).`;
}
