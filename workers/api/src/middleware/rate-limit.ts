import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../index.js";
import { logEvent } from "@releases/lib/log-event";
import { SAFE_METHODS, isTrustedProxy, resolveAuthIdentity } from "./auth.js";

// Window shared by both limiter bindings (CF constraint: period is 10 or 60).
const RATE_LIMIT_WINDOW_SECONDS = 60;

// Mirror `simple.limit` for each `ratelimit` binding in workers/api/wrangler.jsonc.
// Surfaced via the RateLimit-Policy header so AI agents and other well-behaved
// consumers can self-pace before hitting a 429.
const IP_RATE_LIMIT_QUOTA = 120;
const TOKEN_RATE_LIMIT_QUOTA = 600;

const IP_POLICY_NAME = "public";
const TOKEN_POLICY_NAME = "token";

/** IETF draft-ietf-httpapi-ratelimit-headers structured-field policy advertisement. */
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

/**
 * Rate limiting for reads. Anonymous (or invalid-credential) callers are limited
 * per-IP; `relk_` tokens are limited per-token, keyed by tokenId. The static root
 * key (CLI/MCP/scripts) and the trusted web-frontend proxy are exempt. Each
 * limiter is independently gated by its own kill switch + binding, so either can
 * run without the other; with both off this is a no-op (today's behavior).
 */
export const publicRateLimitMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method)) return next();

  const identity = await resolveAuthIdentity(c);
  if (identity?.kind === "root") return next(); // break-glass key: never throttled
  if (await isTrustedProxy(c)) return next(); // web SSR: never throttled

  if (identity?.kind === "token") {
    if (c.env.TOKEN_RATE_LIMIT_ENABLED !== "true" || !c.env.TOKEN_RATE_LIMITER) return next();
    const rejected = await enforce(
      c,
      c.env.TOKEN_RATE_LIMITER,
      identity.tokenId,
      TOKEN_POLICY_NAME,
      TOKEN_RATE_LIMIT_QUOTA,
    );
    if (rejected) {
      logEvent("warn", {
        component: "rate-limit",
        event: "token-throttled",
        tokenId: identity.tokenId,
      });
      return rejected;
    }
    return next();
  }

  // Anonymous or invalid credential → per-IP limiter.
  if (c.env.RATE_LIMIT_ENABLED !== "true" || !c.env.PUBLIC_RATE_LIMITER) return next();
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const rejected = await enforce(
    c,
    c.env.PUBLIC_RATE_LIMITER,
    ip,
    IP_POLICY_NAME,
    IP_RATE_LIMIT_QUOTA,
  );
  if (rejected) return rejected;
  return next();
};
