export type SecretBinding = { get(): Promise<string | null> } | { get(): Promise<string> };
type CachedSecret = { value: string | null; loadedAt: number };

const cache = new WeakMap<SecretBinding, CachedSecret>();

const RETRY_DELAYS_MS = [100, 400];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/**
 * Resolve a Cloudflare Secrets Store binding once per isolate. Subsequent
 * calls return the cached value without hitting the Secrets Store. Use for
 * auth tokens and other long-lived secrets — DO NOT use for short-lived
 * tokens, rotated credentials, or anything that needs to reflect updates
 * within a single isolate's lifetime.
 *
 * Retries transient .get() failures with backoff (100ms, then 400ms); throws if
 * every attempt fails (the caller decides whether to soft-fail or surface).
 * The Secrets Store backend fails sporadically ("Secrets Worker: Failed to
 * fetch secret"), and a single 50ms retry was not always enough to ride it out.
 */
export async function getSecret(binding: SecretBinding | undefined): Promise<string | null> {
  if (!binding) return null;

  const cached = cache.get(binding);
  if (cached) return cached.value;

  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential retry with backoff; Promise.all is not applicable
      const value = await binding.get();
      cache.set(binding, { value, loadedAt: Date.now() });
      return value;
    } catch (err) {
      lastErr = err;
      const delay = RETRY_DELAYS_MS[attempt];
      // oxlint-disable-next-line no-await-in-loop -- intentional sequential backoff between retry attempts
      if (delay !== undefined) await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(
    `Failed to resolve secret after ${MAX_ATTEMPTS} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}
