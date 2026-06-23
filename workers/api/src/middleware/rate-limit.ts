import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../index.js";
import { FLAGS, flag } from "@releases/lib/flags";
import { logEvent } from "@releases/lib/log-event";
import { OAUTH_JWT_TOKEN_PREFIX } from "@releases/lib/consumption-ref";
import { isUserApiKeyShaped } from "@buildinternet/releases-core/api-token";
import {
  resolveTierEnforcement,
  resolveAccountFromCache,
  RATE_LIMIT_WINDOW_SECONDS,
  type RateLimitPrincipal,
  type TierLimiters,
} from "@releases/lib/rate-limit-tiers";
import {
  SAFE_METHODS,
  isTrustedProxy,
  resolveAuthIdentity,
  validateAccountCredential,
} from "./auth.js";

/** Advertise the IETF RateLimit-Policy structured field for a tier. */
function policyHeader(name: string, quota: number): string {
  return `"${name}";q=${quota};w=${RATE_LIMIT_WINDOW_SECONDS}`;
}

type Limiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

/**
 * Consult `limiter` for `key`, advertise the policy, and return a 429 Response
 * when over quota (else `null` to continue). The Cloudflare ratelimit binding
 * returns only `{success}`, so we can't emit a precise RateLimit-Remaining —
 * clients pace off the advertised policy header.
 */
async function enforce(
  c: Context<Env>,
  limiter: Limiter,
  key: string,
  policyName: string,
  quota: number,
): Promise<Response | null> {
  const { success } = await limiter.limit({ key });
  c.header("RateLimit-Policy", policyHeader(policyName, quota));
  if (success) return null;
  c.header("RateLimit", `"${policyName}";r=0;t=${RATE_LIMIT_WINDOW_SECONDS}`);
  c.header("Retry-After", String(RATE_LIMIT_WINDOW_SECONDS));
  return c.json(
    { error: "rate_limited", message: "Too many requests. Please retry shortly." },
    429,
  );
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

  const rejected = await enforce(c, plan.limiter, plan.key, plan.policyName, plan.quota);
  // Decision-event emission is added in Task 6.
  if (rejected) {
    logEvent("warn", {
      component: "rate-limit",
      event: `${plan.tier}-throttled`,
      bucketKey: plan.tier === "anonymous" ? plan.key : undefined,
    });
    return rejected;
  }
  return next();
};
