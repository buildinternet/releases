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

/**
 * Rate limiting for reads. Three rungs on Cloudflare's native limiter: anonymous
 * (per-IP, 120), account (per-userId, 300), machine (per-token, 600). Root + the
 * trusted web proxy are exempt. Each rung is independently gated by its binding +
 * kill switch; with all off this is a no-op.
 */
export const publicRateLimitMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method)) return next();

  const rateLimitEnabled = await flag(
    c.env.FLAGS,
    c.env.RATE_LIMIT_ENABLED,
    FLAGS.rateLimitEnabled,
  );
  const limiters = selectTierLimiters(rateLimitEnabled, c.env.TOKEN_RATE_LIMIT_ENABLED === "true", {
    anonymous: c.env.PUBLIC_RATE_LIMITER,
    account: c.env.USER_RATE_LIMITER,
    machine: c.env.TOKEN_RATE_LIMITER,
  });
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
