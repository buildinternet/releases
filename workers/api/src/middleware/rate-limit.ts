import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../index.js";
import { FLAGS, flag } from "@releases/lib/flags";
import { logEvent } from "@releases/lib/log-event";
import { isUserApiKeyShaped } from "@buildinternet/releases-core/api-token";
import {
  resolveTierEnforcement,
  resolveAccountFromCache,
  rateLimitConsumerRef,
  rateLimitDecisionPayload,
  classifyTokenId,
  accountBucketKey,
  policyHeader,
  RATE_LIMITED_ERROR,
  selectTierLimiters,
  RATE_LIMIT_WINDOW_SECONDS,
  type RateLimitPrincipal,
  type RateLimitTier,
} from "@releases/lib/rate-limit-tiers";
import {
  SAFE_METHODS,
  isTrustedProxy,
  resolveAuthIdentity,
  validateAccountCredential,
  apiRouteFamily,
} from "./auth.js";

/** Anonymous-allowed events are sampled to bound public-read log volume. */
const ANON_SAMPLE_RATE = 0.05;
function sampled(rate: number): boolean {
  const buf = new Uint8Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 256 < rate;
}

/** Emit the consumption decision event (always for account/machine + throttles). */
async function emitDecision(
  c: Context<Env>,
  tier: RateLimitTier,
  bucketKey: string,
  rateLimited: boolean,
): Promise<void> {
  if (tier === "anonymous" && !rateLimited && !sampled(ANON_SAMPLE_RATE)) return;
  const payload = rateLimitDecisionPayload({
    surface: "api",
    tier,
    rateLimited,
    consumerRef: await rateLimitConsumerRef(bucketKey),
    operation: `${c.req.method} ${apiRouteFamily(c.req.path)}`,
  });
  logEvent("info", { ...payload });
}

/** Native limiter shape (per-IP edge limiter; subset of the binding). */
type EdgeLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

/**
 * Bucket an IP for the edge limiter. IPv4 (and the "unknown" sentinel) key as-is;
 * IPv6 collapses to its `/64` prefix so an attacker can't rotate through the
 * 2^64 addresses of a single `/64` to mint unlimited per-IP buckets. Mirrors
 * Better Auth's own default (`advanced.ipAddress.ipv6Subnet = 64`), which already
 * protects the per-key second layer — this brings the edge first layer to parity.
 * A malformed address falls back to the raw value (more granular ⇒ never blocks a
 * legitimate caller; worst case is no coarsening, never over-blocking).
 */
export function edgeRateLimitIpKey(ip: string): string {
  if (!ip.includes(":")) return ip; // IPv4 or sentinel
  const addr = ip.split("%")[0]; // drop any zone id
  let groups: string[];
  if (addr.includes("::")) {
    const [head, tail = ""] = addr.split("::");
    const headGroups = head ? head.split(":") : [];
    const tailGroups = tail ? tail.split(":") : [];
    const fill = Math.max(0, 8 - headGroups.length - tailGroups.length);
    groups = [...headGroups, ...Array(fill).fill("0"), ...tailGroups];
  } else {
    groups = addr.split(":");
  }
  if (groups.length < 4) return ip; // malformed → raw (granular, safe)
  return `${groups
    .slice(0, 4)
    .map((g) => g || "0")
    .join(":")}::/64`;
}

/**
 * Select the edge per-IP limiter for an /api/auth/* request (#1728). Runs ONLY
 * for mutating POSTs (GET session reads are exempt — they neither brute-force
 * nor write-amplify into D1, and are often polled behind shared NAT). Default-on
 * kill switch: only the literal "false" opts out. Returns `undefined` (→ no-op)
 * when the method is exempt, the switch is off, or the binding is unbound.
 */
export function selectAuthEdgeLimiter(
  method: string,
  enabledVar: string | undefined,
  limiter: EdgeLimiter | undefined,
): EdgeLimiter | undefined {
  if (method !== "POST") return undefined;
  if (enabledVar === "false") return undefined;
  return limiter;
}

function bearer(c: Context<Env>): string {
  const h = c.req.header("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

/**
 * Classify the caller into a rate-limit tier. Root + trusted proxy are exempt.
 * `relk_` machine tokens → machine rung (keyed on tokenId). OAuth-JWT users
 * (`oauth_…`) and valid `relu_` keys → account rung (keyed on userId). Everything
 * else → anonymous (keyed on IP). The `relu_` path verifies behind the KV cache
 * so a junk string can't mint an account bucket (it caches invalid → IP rung).
 */
async function classifyPrincipal(
  c: Context<Env>,
  accountActive: boolean,
): Promise<RateLimitPrincipal> {
  if (await isTrustedProxy(c)) return { tier: "exempt" };
  const identity = await resolveAuthIdentity(c);
  if (identity?.kind === "root") return { tier: "exempt" };
  if (identity?.kind === "token") {
    const id = identity.tokenId;
    const tier = classifyTokenId(id);
    // Account tier → bucket on the userId (strip the oauth_ prefix) so a user's
    // OAuth and API-key traffic share one per-account budget. A relu_ key never
    // reaches this branch (resolveAuthIdentity reads it as anonymous), so an
    // account tier here is always OAuth.
    return { tier, bucketKey: tier === "account" ? accountBucketKey(id) : id };
  }
  // Identity unresolved. A relu_ key is read as anonymous by resolveAuthIdentity
  // (meter-skip), so verify it here for tiering, behind the KV cache.
  // Skip the KV read when the account rung is inactive (eff#5).
  const presented = bearer(c);
  if (accountActive && presented && isUserApiKeyShaped(presented)) {
    const account = await resolveAccountFromCache({
      credential: presented,
      cache: c.env.CREDENTIAL_CACHE,
      validate: () => validateAccountCredential(c, presented),
    });
    if (account.valid && account.userId) return { tier: "account", bucketKey: account.userId };
  }
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  return { tier: "anonymous", bucketKey: ip };
}

export type PublicRateLimitOptions = {
  /**
   * Also limit non-safe methods. OFF by default: nearly every write behind this
   * middleware is auth-gated and carries its own limiter, and throttling those
   * per-IP would punish a shared NAT for authenticated traffic.
   *
   * Turn it ON for anonymous write lanes, where per-IP is the only handle there
   * is — an emailed-token endpoint like `POST /digest/unsubscribe/:token`. Note
   * this middleware silently passes POST through otherwise, so mounting it over
   * a POST-only route without this flag reads as protection that isn't there
   * (that was the bug behind #2158).
   */
  unsafeMethods?: boolean;
};

/**
 * Rate limiting for reads. Three rungs on Cloudflare's native limiter: anonymous
 * (per-IP, 120), account (per-userId, 300), machine (per-token, 600). Root + the
 * trusted web proxy are exempt. Each rung is independently gated by its binding +
 * kill switch; with all off this is a no-op.
 */
export function publicRateLimit(opts: PublicRateLimitOptions = {}): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (!opts.unsafeMethods && !SAFE_METHODS.has(c.req.method)) return next();

    const rateLimitEnabled = await flag(
      c.env.FLAGS,
      c.env.RATE_LIMIT_ENABLED,
      FLAGS.rateLimitEnabled,
    );
    const limiters = selectTierLimiters(
      rateLimitEnabled,
      c.env.TOKEN_RATE_LIMIT_ENABLED === "true",
      {
        anonymous: c.env.PUBLIC_RATE_LIMITER,
        account: c.env.USER_RATE_LIMITER,
        machine: c.env.TOKEN_RATE_LIMITER,
      },
    );
    if (!limiters.anonymous && !limiters.account && !limiters.machine) return next();

    const principal = await classifyPrincipal(c, !!limiters.account);
    const plan = resolveTierEnforcement(principal, limiters);
    if (!plan) return next(); // exempt
    if (!plan.limiter) return next(); // this rung disabled → allow

    const { success } = await plan.limiter.limit({ key: plan.key });
    c.header("RateLimit-Policy", policyHeader(plan.policyName, plan.quota));
    const emit = emitDecision(c, plan.tier, plan.key, !success);
    try {
      c.executionCtx.waitUntil(emit);
    } catch {
      // no executionCtx in tests — await inline to keep assertions deterministic
      await emit;
    }
    if (success) return next();
    c.header("RateLimit", `"${plan.policyName}";r=0;t=${RATE_LIMIT_WINDOW_SECONDS}`);
    c.header("Retry-After", String(RATE_LIMIT_WINDOW_SECONDS));
    return c.json(RATE_LIMITED_ERROR, 429);
  };
}

/** The default instance: safe methods only. */
export const publicRateLimitMiddleware: MiddlewareHandler<Env> = publicRateLimit();
