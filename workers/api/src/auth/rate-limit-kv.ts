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
 * Tradeoff: KV is eventually consistent and has no atomic compare-and-set, so
 * `consume()` here is a read-decide-write and a single key's counter is
 * best-effort under concurrency. That is acceptable here: the edge per-IP
 * native limiter in front of `/api/auth/*` is the strict first gate, and this
 * per-key limiter is the precise-but-soft second layer. The win is structural —
 * flood writes no longer touch the shared D1.
 *
 * Better Auth 1.7 replaced the `get`/`set` custom-storage contract with a single
 * `consume(key, rule)` step (the separate shape could not enforce a distributed
 * limit under concurrency). The decision logic below mirrors the upstream
 * `decideConsume` reducer exactly — same rolling-window reset, same
 * `count >= max` rejection, same `retryAfter` rounding — so KV and the database
 * backend behave identically apart from the atomicity caveat above.
 */

/** Better Auth's rate-limit record shape (model `rateLimit`). `lastRequest` is epoch ms. */
export interface RateLimitRecord {
  key: string;
  count: number;
  lastRequest: number;
}

/** One rate-limit rule as Better Auth passes it to `consume`. */
export interface RateLimitRule {
  /** Rolling window length, in seconds. */
  window: number;
  /** Maximum requests allowed within the window. */
  max: number;
}

/** Better Auth's `consume` verdict: allowed, plus seconds until the window frees up. */
export interface RateLimitDecision {
  allowed: boolean;
  retryAfter: number | null;
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
 * Read one stored record. A missing, malformed, or wrong-shape value reads as
 * `null` (fail-open to a fresh window) rather than throwing — a corrupt counter
 * must never 500 the sign-in path. Exported for tests.
 */
export async function readRecord(kv: RateLimitKv, key: string): Promise<RateLimitRecord | null> {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RateLimitRecord>;
    if (typeof parsed?.count !== "number" || typeof parsed?.lastRequest !== "number") return null;
    return { key, count: parsed.count, lastRequest: parsed.lastRequest };
  } catch {
    return null;
  }
}

/**
 * Build the `rateLimit.customStorage` object backed by `kv`, implementing Better
 * Auth 1.7's single-step `consume(key, rule)` contract. Every write carries a
 * TTL of at least {@link AUTH_RATE_LIMIT_KV_TTL_SECONDS} — stretched to the
 * rule's own window when that is longer — so counters self-expire without ever
 * being dropped mid-window.
 */
export function kvRateLimitStorage(kv: RateLimitKv) {
  return {
    async consume(key: string, rule: RateLimitRule): Promise<RateLimitDecision> {
      const now = Date.now();
      const windowMs = rule.window * 1000;
      const data = await readRecord(kv, key);

      const write = async (record: RateLimitRecord): Promise<void> => {
        await kv.put(key, JSON.stringify(record), {
          // Never expire the counter before its own window closes: a rule with
          // a window longer than the floor would otherwise lose its record
          // mid-window and hand the caller a fresh quota.
          expirationTtl: Math.max(AUTH_RATE_LIMIT_KV_TTL_SECONDS, Math.ceil(rule.window)),
        });
      };

      // No record, or the rolling window has elapsed: start a fresh window.
      if (!data || now - data.lastRequest >= windowMs) {
        await write({ key, count: 1, lastRequest: now });
        return { allowed: true, retryAfter: null };
      }
      // Limit already reached inside the live window: reject, don't advance
      // `lastRequest` (upstream leaves the record untouched, so the window still
      // expires on schedule rather than being extended by rejected attempts).
      if (data.count >= rule.max) {
        return {
          allowed: false,
          retryAfter: Math.ceil((data.lastRequest + windowMs - now) / 1000),
        };
      }
      await write({ key, count: data.count + 1, lastRequest: now });
      return { allowed: true, retryAfter: null };
    },
  };
}
