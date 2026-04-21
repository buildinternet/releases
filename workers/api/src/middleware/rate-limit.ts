import type { MiddlewareHandler } from "hono";
import type { Env } from "../index.js";
import { SAFE_METHODS, isValidBearerAuth, isTrustedProxy } from "./auth.js";

/**
 * Per-IP rate limiter for unauthenticated public reads.
 * Admin-bearer callers (CLI/MCP) and trusted-proxy callers (web frontend)
 * bypass so server-to-server and tooling traffic is never throttled.
 */
export const publicRateLimitMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  if (c.env.RATE_LIMIT_ENABLED !== "true") return next();
  if (!c.env.PUBLIC_RATE_LIMITER) return next();
  if (!SAFE_METHODS.has(c.req.method)) return next();

  if (await isValidBearerAuth(c)) return next();
  if (await isTrustedProxy(c)) return next();

  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const { success } = await c.env.PUBLIC_RATE_LIMITER.limit({ key: ip });
  if (!success) {
    c.header("Retry-After", "60");
    return c.json(
      { error: "rate_limited", message: "Too many requests. Please retry shortly." },
      429,
    );
  }
  return next();
};
