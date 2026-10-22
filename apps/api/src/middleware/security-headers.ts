import type { MiddlewareHandler } from "hono";

/**
 * Baseline security headers on every response.
 *
 * 101 (WebSocket upgrade) is skipped — headers immutable. Same skip as
 * `cacheDefaultDeny`. Mutating a Workers 101 throws
 * "Can't modify immutable headers" and the upgrade becomes a 500.
 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.res.status === 101) return;
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("X-Frame-Options", "DENY");
    c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  };
}
