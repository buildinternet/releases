/**
 * Small retry wrapper around `fetch`, purpose-built for build-time fetches
 * (build-well-known.ts) where a transient network blip shouldn't fail a
 * production deploy but a real 404 should fail loudly and fast.
 *
 * Retries a thrown network error (e.g. ECONNRESET) or a 5xx/429 response.
 * Does NOT retry a 404 or other 4xx — that means the resource moved or
 * doesn't exist, and retrying won't help.
 */
export interface FetchWithRetryOptions {
  attempts?: number;
  /** Backoff delay (ms) before each retry, indexed by retry number (0-based). */
  backoffMs?: number[];
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = [250, 1000];

export async function fetchWithRetry(
  url: string,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      // 4xx (except 429) is the caller's problem, not a transient one: a 404
      // means the skill moved and retrying only delays a failure that should be
      // loud. Hand the response back and let the caller's `res.ok` check throw.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) return res;
      lastError = new Error(`Fetch ${url} failed: ${res.status}`);
    } catch (err) {
      lastError = err;
    }

    const isLastAttempt = attempt === attempts - 1;
    if (!isLastAttempt) {
      const delay = backoffMs[attempt] ?? backoffMs[backoffMs.length - 1] ?? 0;
      await sleep(delay);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
