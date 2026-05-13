type SecretBinding = { get(): Promise<string | null> } | { get(): Promise<string> };
type CachedSecret = { value: string | null; loadedAt: number };

const cache = new WeakMap<SecretBinding, CachedSecret>();

/**
 * Resolve a Cloudflare Secrets Store binding once per isolate. Subsequent
 * calls return the cached value without hitting the Secrets Store. Use for
 * auth tokens and other long-lived secrets — DO NOT use for short-lived
 * tokens, rotated credentials, or anything that needs to reflect updates
 * within a single isolate's lifetime.
 *
 * Retries once on transient .get() failure with 50ms backoff; throws if both
 * attempts fail (the caller decides whether to soft-fail or surface).
 */
export async function getSecret(binding: SecretBinding | undefined): Promise<string | null> {
  if (!binding) return null;

  const cached = cache.get(binding);
  if (cached) return cached.value;

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential retry with 50ms backoff; Promise.all is not applicable
      const value = await binding.get();
      cache.set(binding, { value, loadedAt: Date.now() });
      return value;
    } catch (err) {
      lastErr = err;
      // oxlint-disable-next-line no-await-in-loop -- intentional sequential backoff between retry attempts
      if (attempt === 0) await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(
    `Failed to resolve secret after 2 attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}
