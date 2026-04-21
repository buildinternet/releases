import type { MiddlewareHandler } from "hono";

/**
 * When `INDEXING_DISABLED` is truthy (set in `[env.staging]`), short-circuit
 * `/robots.txt` with a deny-all body and stamp `X-Robots-Tag: noindex, nofollow`
 * on every other response.
 *
 * `X-Robots-Tag` is the belt to `/robots.txt`'s suspenders — Google honors the
 * header even for non-HTML content (JSON, redirects), so it covers the API
 * surface that a plain robots.txt wouldn't.
 */
export function blockIndexing(): MiddlewareHandler<{
  Bindings: { INDEXING_DISABLED?: string };
}> {
  return async (c, next) => {
    if (c.env.INDEXING_DISABLED !== "true") {
      await next();
      return;
    }
    if (c.req.method === "GET" && new URL(c.req.url).pathname === "/robots.txt") {
      return c.text("User-agent: *\nDisallow: /\n", 200, {
        "Cache-Control": "public, max-age=3600",
      });
    }
    await next();
    c.res.headers.set("X-Robots-Tag", "noindex, nofollow");
  };
}
