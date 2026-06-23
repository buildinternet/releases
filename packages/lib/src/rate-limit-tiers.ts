/**
 * Shared rate-limit tier policy for the API and MCP workers. Pure and
 * runtime-neutral — counters live on Cloudflare's native `ratelimit` bindings,
 * passed in as the structural `RateLimiter` type (mirrors the binding shape).
 */

import { hashSecret } from "@buildinternet/releases-core/api-token";

/** CF constraint: a ratelimit binding period is 10 or 60. We use 60 everywhere. */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/** Quotas mirror `simple.limit` for each binding in the workers' wrangler.jsonc. */
export const TIER_QUOTAS = { anonymous: 120, account: 300, machine: 600 } as const;

/** IETF RateLimit-Policy names advertised to clients per tier. */
export const TIER_POLICY = { anonymous: "public", account: "account", machine: "token" } as const;

export type RateLimitTier = "anonymous" | "account" | "machine";

/** Structural shape of a Cloudflare `ratelimit` unsafe binding. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * A resolved caller, already classified by the worker. `bucketKey` is the
 * rate-limit bucket: `userId` for account, `tokenId` for machine, IP for
 * anonymous. `exempt` covers the root key and the trusted web proxy.
 */
export type RateLimitPrincipal =
  | { tier: "exempt" }
  | { tier: "machine"; bucketKey: string }
  | { tier: "account"; bucketKey: string }
  | { tier: "anonymous"; bucketKey: string };

/** The active limiter binding per rung (undefined when that rung is disabled). */
export interface TierLimiters {
  anonymous?: RateLimiter;
  account?: RateLimiter;
  machine?: RateLimiter;
}

export interface TierEnforcement {
  tier: RateLimitTier;
  /** undefined → this rung's limiter is off/absent → the caller should allow. */
  limiter?: RateLimiter;
  key: string;
  policyName: string;
  quota: number;
}

/**
 * Resolve which limiter + bucket key + quota apply to `principal`. Returns null
 * for exempt callers. A non-null result with `limiter === undefined` means the
 * matching rung is disabled — the caller allows the request (still advertising
 * the policy if it wishes).
 */
export function resolveTierEnforcement(
  principal: RateLimitPrincipal,
  limiters: TierLimiters,
): TierEnforcement | null {
  if (principal.tier === "exempt") return null;
  const tier = principal.tier;
  return {
    tier,
    limiter: limiters[tier],
    key: principal.bucketKey,
    policyName: TIER_POLICY[tier],
    quota: TIER_QUOTAS[tier],
  };
}

/** Structural subset of a Cloudflare KVNamespace used for validation caching. */
export interface CredentialCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface AccountValidation {
  valid: boolean;
  userId?: string;
}

/** Short TTL: bounds the rate-tier revocation lag (auth itself is always live). */
export const CREDENTIAL_CACHE_TTL_SECONDS = 60;

/** Serialized cache value: `1|<userId>` for valid, `0` for invalid. */
function encode(v: AccountValidation): string {
  return v.valid ? `1|${v.userId ?? ""}` : "0";
}
function decode(raw: string): AccountValidation | null {
  if (raw === "0") return { valid: false };
  if (raw.startsWith("1|")) {
    const userId = raw.slice(2) || undefined;
    return { valid: true, userId };
  }
  return null; // unknown/corrupt format → treat as a miss, re-validate (fail-closed)
}

/**
 * Resolve whether `credential` belongs to a real account, caching the result in
 * KV keyed on a hash of the credential (never the raw credential). On a miss,
 * `validate()` runs once and the result (positive OR negative) is cached for
 * `ttlSeconds`. With no cache, `validate()` runs every call. This bounds the
 * verify/meter cost to at most once per credential per TTL window and blocks the
 * bypass where a junk credential would otherwise mint a fresh account bucket.
 */
export async function resolveAccountFromCache(opts: {
  credential: string;
  cache: CredentialCache | undefined;
  validate: () => Promise<AccountValidation>;
  ttlSeconds?: number;
}): Promise<AccountValidation> {
  const { credential, cache, validate } = opts;
  const ttl = opts.ttlSeconds ?? CREDENTIAL_CACHE_TTL_SECONDS;
  if (!cache) return validate();
  const cacheKey = `ratelimit:cred:${await hashSecret(credential)}`;
  const cached = await cache.get(cacheKey);
  if (cached !== null) {
    const decoded = decode(cached);
    if (decoded !== null) return decoded;
    // unknown format → fall through to re-validate and overwrite the bad entry
  }
  const result = await validate();
  await cache.put(cacheKey, encode(result), { expirationTtl: ttl });
  return result;
}
