import type { MiddlewareHandler } from "hono";

type Env = { Bindings: { CACHE_DISABLED?: string } };

/**
 * Cache-Control middleware for read endpoints.
 * Cloudflare handles gzip/brotli compression at the edge automatically —
 * this middleware sets Cache-Control so the CDN can also cache responses.
 *
 * Set the CACHE_DISABLED env var to any truthy value to skip (e.g. for local dev).
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

    // Skip if caching is disabled via env var
    if (c.env.CACHE_DISABLED) return;

    // Only cache successful GET responses that don't already have Cache-Control
    if (c.req.method !== "GET") return;
    if (c.res.status < 200 || c.res.status >= 300) return;
    if (c.res.headers.get("cache-control")) return;

    c.res.headers.set("Cache-Control", value);
  };
}
