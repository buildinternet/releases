/**
 * fetch() wrapper that retries transient failures — network errors and
 * retryable HTTP statuses (429 + 5xx) — with exponential backoff.
 *
 * Non-retryable responses (2xx, 4xx) and the final attempt are returned as-is,
 * so a caller's existing `if (!res.ok) throw ...` handling is unchanged: a 4xx
 * surfaces immediately, and an exhausted retry returns the last (failing)
 * Response with its body still unread.
 *
 * Added after a transient Anthropic 500 on skill-version creation failed an
 * entire managed-agents deploy (the call had no retry); a manual re-run then
 * succeeded. See scripts/sync-agent-skills.ts.
 */

/** Statuses worth retrying: request timeout, too-early, rate limit, and 5xx. */
export const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

export interface FetchRetryOptions {
  /** Max retries after the first attempt (default 4 → up to 5 total attempts). */
  retries?: number;
  /** Base backoff in ms; delay is baseDelayMs * 2**attempt (default 500). */
  baseDelayMs?: number;
  /** Human label for retry log lines (defaults to the URL). */
  label?: string;
  /** Injectable fetch (for tests); defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep (for tests); defaults to setTimeout. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Retry notifier; defaults to console.log. */
  onRetry?: (info: { attempt: number; retries: number; label: string; reason: string }) => void;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: FetchRetryOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const label = opts.label ?? url;
  const onRetry =
    opts.onRetry ??
    (({ attempt, retries: max, label: l, reason }) =>
      console.log(`  ⟳ ${l}: ${reason}, retrying (attempt ${attempt}/${max})`));

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await doFetch(url, init);
      // Success, a non-retryable status, or out of attempts: hand the Response
      // back so the caller decides (and reads the body) exactly as before.
      if (attempt >= retries || !RETRYABLE_STATUS.has(res.status)) return res;
      onRetry({ attempt: attempt + 1, retries, label, reason: `HTTP ${res.status}` });
    } catch (err) {
      if (attempt >= retries) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      onRetry({ attempt: attempt + 1, retries, label, reason });
    }
    await sleep(baseDelayMs * 2 ** attempt);
  }
}
