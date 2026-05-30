import type { MiddlewareHandler } from "hono";
import { FLAGS, flag, type FlagshipBinding } from "@releases/lib/flags";

type Env = { Bindings: { CACHE_DISABLED?: string; FLAGS?: FlagshipBinding } };

/**
 * Cache-Control middleware for read endpoints.
 * Cloudflare handles gzip/brotli compression at the edge automatically —
 * this middleware sets Cache-Control so the CDN can also cache responses.
 *
 * Set the CACHE_DISABLED env var to "true" to skip (e.g. for local dev), or flip
 * the `cache-disabled` Flagship flag.
 */
export function cacheControl(
  maxAge: number,
  options?: { staleWhileRevalidate?: number; isPublic?: boolean },
): MiddlewareHandler<Env> {
  const swr = options?.staleWhileRevalidate ?? 0;
  const visibility = options?.isPublic ? "public" : "private";

  let value = `${visibility}, max-age=${maxAge}`;
  if (swr > 0) value += `, stale-while-revalidate=${swr}`;

  return async (c, next) => {
    await next();

    // Skip if caching is disabled (Flagship `cache-disabled` → CACHE_DISABLED var).
    if (await flag(c.env.FLAGS, c.env.CACHE_DISABLED, FLAGS.cacheDisabled)) return;

    // Only cache successful GET responses that don't already have Cache-Control
    if (c.req.method !== "GET") return;
    if (c.res.status < 200 || c.res.status >= 300) return;
    if (c.res.headers.get("cache-control")) return;

    c.res.headers.set("Cache-Control", value);
  };
}
