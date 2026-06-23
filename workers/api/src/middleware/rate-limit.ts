import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../index.js";
import { FLAGS, flag } from "@releases/lib/flags";
import { logEvent } from "@releases/lib/log-event";
import { OAUTH_JWT_TOKEN_PREFIX } from "@releases/lib/consumption-ref";
import { isUserApiKeyShaped } from "@buildinternet/releases-core/api-token";
import {
  resolveTierEnforcement,
  resolveAccountFromCache,
  rateLimitConsumerRef,
  rateLimitDecisionPayload,
  RATE_LIMIT_WINDOW_SECONDS,
  type RateLimitPrincipal,
  type RateLimitTier,
  type TierLimiters,
} from "@releases/lib/rate-limit-tiers";
import {
  SAFE_METHODS,
  isTrustedProxy,
  resolveAuthIdentity,
  validateAccountCredential,
  apiRouteFamily,
} from "./auth.js";

/** Advertise the IETF RateLimit-Policy structured field for a tier. */
function policyHeader(name: string, quota: number): string {
  return `"${name}";q=${quota};w=${RATE_LIMIT_WINDOW_SECONDS}`;
}

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
async function classifyPrincipal(c: Context<Env>): Promise<RateLimitPrincipal> {
  if (await isTrustedProxy(c)) return { tier: "exempt" };
  const identity = await resolveAuthIdentity(c);
  if (identity?.kind === "root") return { tier: "exempt" };
  if (identity?.kind === "token") {
    const id = identity.tokenId;
    if (id.startsWith(OAUTH_JWT_TOKEN_PREFIX)) return { tier: "account", bucketKey: id };
    if (isUserApiKeyShaped(id)) return { tier: "account", bucketKey: id };
    return { tier: "machine", bucketKey: id };
  }
  // Identity unresolved. A relu_ key is read as anonymous by resolveAuthIdentity
  // (meter-skip), so verify it here for tiering, behind the KV cache.
  const presented = bearer(c);
  if (presented && isUserApiKeyShaped(presented)) {
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

  const ipEnabled = await flag(c.env.FLAGS, c.env.RATE_LIMIT_ENABLED, FLAGS.rateLimitEnabled);
  const limiters: TierLimiters = {
    anonymous: ipEnabled ? c.env.PUBLIC_RATE_LIMITER : undefined,
    account: ipEnabled ? c.env.USER_RATE_LIMITER : undefined,
    machine: c.env.TOKEN_RATE_LIMIT_ENABLED === "true" ? c.env.TOKEN_RATE_LIMITER : undefined,
  };
  if (!limiters.anonymous && !limiters.account && !limiters.machine) return next();

  const principal = await classifyPrincipal(c);
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
  return c.json(
    { error: "rate_limited", message: "Too many requests. Please retry shortly." },
    429,
  );
};
