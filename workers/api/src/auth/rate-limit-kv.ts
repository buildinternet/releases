/**
 * KV-backed storage for Better Auth's brute-force rate limiter (#1728).
 *
 * Better Auth's default `storage: "database"` upserts a counter row per
 * rate-limit key (IP+path) on every tracked auth attempt. That couples the
 * protection mechanism to the shared D1: a distributed credential-stuffing
 * flood drives high-frequency writes into the same database that serves the
 * catalog/sources/releases, a write-amplification DoS vector. Routing those
 * counters to a dedicated KV namespace keeps them off D1 entirely.
 *
 * Wired via `rateLimit.customStorage` (NOT `secondaryStorage`): customStorage
 * scopes the change to rate-limit data only, whereas configuring
 * `secondaryStorage` would also relocate session + verification records to KV.
 *
 * Tradeoff: KV is eventually consistent and this is the non-atomic
 * check-then-increment path (Better Auth's `legacyConsume` — customStorage has
 * no atomic `consume`), so a single key's counter is best-effort under
 * concurrency. That is acceptable here: the edge per-IP native limiter in front
 * of `/api/auth/*` is the strict first gate, and this per-key limiter is the
 * precise-but-soft second layer. The win is structural — flood writes no longer
 * touch the shared D1.
 */

/** Better Auth's rate-limit record shape (model `rateLimit`). */
export interface RateLimitRecord {
  key: string;
  count: number;
  lastRequest: number;
}

/**
 * KV entries auto-expire after this many seconds. Must comfortably exceed the
 * longest rate-limit window on the auth surface (Better Auth defaults: 60s
 * global, 10s for sign-in/up) so a counter never expires mid-window and resets
 * a brute-force attempt's progress early. 120s clears the 60s window with
 * margin for clock skew; it is also ≥ KV's 60s minimum `expirationTtl`.
 */
export const AUTH_RATE_LIMIT_KV_TTL_SECONDS = 120;

/** Minimal slice of the KV binding this helper needs (eases testing). */
interface RateLimitKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/**
 * Build the `rateLimit.customStorage` object backed by `kv`. Implements the
 * `get`/`set` contract Better Auth's limiter uses; the third `set` argument is
 * an `update` flag (not a TTL), so the TTL is the fixed
 * {@link AUTH_RATE_LIMIT_KV_TTL_SECONDS}. A malformed/legacy stored value reads
 * as `null` (fail-open to a fresh window) rather than throwing.
 */
export function kvRateLimitStorage(kv: RateLimitKv) {
  return {
    async get(key: string): Promise<RateLimitRecord | null> {
      const raw = await kv.get(key);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as Partial<RateLimitRecord>;
        if (typeof parsed?.count !== "number" || typeof parsed?.lastRequest !== "number") {
          return null;
        }
        return { key, count: parsed.count, lastRequest: parsed.lastRequest };
      } catch {
        return null;
      }
    },
    async set(key: string, value: RateLimitRecord, _update?: boolean): Promise<void> {
      await kv.put(key, JSON.stringify(value), {
        expirationTtl: AUTH_RATE_LIMIT_KV_TTL_SECONDS,
      });
    },
  };
}
