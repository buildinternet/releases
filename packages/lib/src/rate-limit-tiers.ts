/**
 * Shared rate-limit tier policy for the API and MCP workers. Pure and
 * runtime-neutral — counters live on Cloudflare's native `ratelimit` bindings,
 * passed in as the structural `RateLimiter` type (mirrors the binding shape).
 */

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
