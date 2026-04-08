import type { MiddlewareHandler } from "hono";
import type { Env } from "../index.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Requires a valid Bearer token for all requests. Returns 401 if missing/invalid. */
export const authMiddleware: MiddlewareHandler<Env> = createAuthMiddleware({ allowPublicReads: false });

/**
 * GET/HEAD/OPTIONS pass through without auth (public read access).
 * POST/PATCH/DELETE require a valid Bearer token.
 */
export const publicReadAuthMiddleware: MiddlewareHandler<Env> = createAuthMiddleware({ allowPublicReads: true });

function createAuthMiddleware(opts: { allowPublicReads: boolean }): MiddlewareHandler<Env> {
  return async (c, next) => {
    // Public reads skip auth entirely — no need to fetch the secret
    if (opts.allowPublicReads && SAFE_METHODS.has(c.req.method)) {
      await next();
      return;
    }

    const secret = await c.env.RELEASED_API_KEY?.get();

    // No secret configured — skip auth (local dev)
    if (!secret) {
      await next();
      return;
    }

    const header = c.req.header("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";

    if (token !== secret) {
      return c.json({ error: "unauthorized", message: "Invalid or missing API key" }, 401);
    }

    await next();
  };
}
