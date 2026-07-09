/**
 * Retry policy for Durable Object stub RPCs.
 *
 * CF marks some DO errors `retryable` (safe to retry) and others `overloaded`
 * (must not retry — amplifies load). See:
 * https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
 *
 * Used for actor arming (ensureScheduled / ensureDrainScheduled / onSourceChanged)
 * where a cron or alarm backstop already exists if the budget is exhausted.
 */

const ATTEMPTS = 3;
const BASE_MS = 50;
const MAX_MS = 500;

/** True when a DO stub error is safe to retry (never when overloaded). */
export function isErrorRetryable(err: unknown): boolean {
  const e = err as { retryable?: unknown; overloaded?: unknown } | null;
  return !!e?.retryable && !e?.overloaded && !String(err).includes("Durable Object is overloaded");
}

/** Retry a DO stub RPC a few times with full-jitter backoff, then rethrow. */
export async function withDoRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= ATTEMPTS || !isErrorRetryable(err)) throw err;
      const cap = Math.min(2 ** attempt * BASE_MS, MAX_MS);
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * cap)));
    }
  }
}

/** Exported for tests that assert the arming attempt budget. */
export const DO_ARM_ATTEMPTS = ATTEMPTS;
