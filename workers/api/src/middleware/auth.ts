import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../index.js";

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Custom header carrying the trusted-proxy shared secret. */
export const PROXY_KEY_HEADER = "X-Releases-Proxy-Key";

/**
 * Returns true iff the request carries an `Authorization: Bearer <token>` header
 * matching the configured `RELEASED_API_KEY` secret. Admin-level — gates writes
 * and unlocks internal fields (e.g. org playbook) on public-read routes.
 */
export async function isValidBearerAuth(c: Context<Env>): Promise<boolean> {
  const header = c.req.header("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const secret = await c.env.RELEASED_API_KEY?.get();
  if (!secret) return false;
  return header.slice(7) === secret;
}

/**
 * Returns true iff the request carries an `X-Releases-Proxy-Key` header matching
 * the configured `RELEASES_PROXY_KEY` secret. Server-trust signal only — used
 * by the rate limiter to exempt the web frontend's server-to-server traffic from
 * the per-IP limit. Does NOT unlock admin-gated content.
 */
export async function isTrustedProxy(c: Context<Env>): Promise<boolean> {
  const header = c.req.header(PROXY_KEY_HEADER);
  if (!header) return false;
  const secret = await c.env.RELEASES_PROXY_KEY?.get();
  if (!secret) return false;
  return header === secret;
}

/** Requires a valid Bearer token for all requests. Returns 401 if missing/invalid. */
export const authMiddleware: MiddlewareHandler<Env> = createAuthMiddleware({
  allowPublicReads: false,
});

/**
 * GET/HEAD/OPTIONS pass through without auth (public read access).
 * POST/PATCH/DELETE require a valid Bearer token.
 */
export const publicReadAuthMiddleware: MiddlewareHandler<Env> = createAuthMiddleware({
  allowPublicReads: true,
});

function createAuthMiddleware(opts: { allowPublicReads: boolean }): MiddlewareHandler<Env> {
  return async (c, next) => {
    // Public reads skip auth entirely — no need to fetch the secret
    if (opts.allowPublicReads && SAFE_METHODS.has(c.req.method)) {
      await next();
      return;
    }

    // No secret configured — skip auth (local dev)
    const secret = await c.env.RELEASED_API_KEY?.get();
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
