import type { MiddlewareHandler } from "hono";
import type { Env } from "../index.js";
import { SAFE_METHODS, hasValidAuth, isTrustedProxy } from "./auth.js";

// Mirrors `simple.limit` / `simple.period` in workers/api/wrangler.jsonc.
// Surfaced to clients via the RateLimit-Policy header so AI agents and other
// well-behaved consumers can self-pace before hitting a 429.
const RATE_LIMIT_QUOTA = 120;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_POLICY_NAME = "public";

/** IETF draft-ietf-httpapi-ratelimit-headers structured-field policy advertisement. */
const RATE_LIMIT_POLICY_HEADER = `"${RATE_LIMIT_POLICY_NAME}";q=${RATE_LIMIT_QUOTA};w=${RATE_LIMIT_WINDOW_SECONDS}`;

/**
 * Per-IP rate limiter for unauthenticated public reads.
 * Admin-bearer callers (CLI/MCP) and trusted-proxy callers (web frontend)
 * bypass so server-to-server and tooling traffic is never throttled.
 */
export const publicRateLimitMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  if (c.env.RATE_LIMIT_ENABLED !== "true") return next();
  if (!c.env.PUBLIC_RATE_LIMITER) return next();
  if (!SAFE_METHODS.has(c.req.method)) return next();

  // Authenticated callers (static root key or any active DB token) bypass.
  if (await hasValidAuth(c)) return next();
  if (await isTrustedProxy(c)) return next();

  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const { success } = await c.env.PUBLIC_RATE_LIMITER.limit({ key: ip });
  // Always advertise the policy so agents can pace themselves before a 429.
  // The Cloudflare ratelimit binding only returns {success}, so we can't
  // emit a precise RateLimit-Remaining; clients should treat the policy
  // header as the authoritative quota signal.
  c.header("RateLimit-Policy", RATE_LIMIT_POLICY_HEADER);
  if (!success) {
    c.header("RateLimit", `"${RATE_LIMIT_POLICY_NAME}";r=0;t=${RATE_LIMIT_WINDOW_SECONDS}`);
    c.header("Retry-After", String(RATE_LIMIT_WINDOW_SECONDS));
    return c.json(
      { error: "rate_limited", message: "Too many requests. Please retry shortly." },
      429,
    );
  }
  return next();
};
