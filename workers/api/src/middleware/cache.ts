import type { MiddlewareHandler } from "hono";
import { FLAGS, flag, type FlagshipBinding } from "@releases/lib/flags";

type Env = { Bindings: { CACHE_DISABLED?: string; FLAGS?: FlagshipBinding } };

/**
 * Cache-Control middleware for read endpoints.
 *
 * The emitted `Cache-Control` header is the freshness contract Workers Cache
 * (wrangler `cache.enabled`, see wrangler.jsonc) reads to decide whether —
 * and for how long — to store the response at the edge; a cache hit never
 * runs the Worker. The optional `tags` option additionally sets a `Cache-Tag`
 * header, which is what `ctx.cache.purge({ tags })` / `cache.purge({ tags })`
 * (from `cloudflare:workers`) target for programmatic invalidation — see
 * lib/latest-cache.ts for the one caller that purges by tag today.
 *
 * Set the CACHE_DISABLED env var to "true" to skip (e.g. for local dev), or flip
 * the `cache-disabled` Flagship flag. This is now the runtime "stop caching new
 * entries" lever for Workers Cache too: flipping it stops this middleware from
 * setting Cache-Control (so nothing new gets cached), but it does NOT purge
 * whatever Workers Cache already stored under the old header — those entries
 * simply age out over their remaining max-age. For an immediate flush, purge by
 * tag (`ctx.cache.purge`) or wait out the TTL; the flag is a slow-drain kill
 * switch, not an instant flush.
 */
export function cacheControl(
  maxAge: number,
  options?: { staleWhileRevalidate?: number; isPublic?: boolean; tags?: string[] },
): MiddlewareHandler<Env> {
  const swr = options?.staleWhileRevalidate ?? 0;
  const visibility = options?.isPublic ? "public" : "private";
  const tags = options?.tags;

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
    if (tags && tags.length > 0) c.res.headers.set("Cache-Tag", tags.join(","));
  };
}
