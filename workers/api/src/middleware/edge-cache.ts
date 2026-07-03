import type { Context, MiddlewareHandler } from "hono";
import { FLAGS, flag, type FlagshipBinding } from "@releases/lib/flags";
import { acceptPrefersMarkdown } from "./content-negotiation.js";

type Env = { Bindings: { CACHE_DISABLED?: string; FLAGS?: FlagshipBinding } };

/**
 * Minimal structural view of `caches.default`. The Cloudflare `CacheStorage`
 * type collides with the DOM lib's same-named interface under the repo's root
 * type-check, so we reach the worker-side default cache through this narrow
 * shape rather than the ambient (DOM-resolved) `CacheStorage`.
 */
interface EdgeCacheStore {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

function defaultCache(): EdgeCacheStore | undefined {
  if (typeof caches === "undefined") return undefined;
  return (caches as unknown as { default: EdgeCacheStore }).default;
}

/**
 * Worker-side shared edge cache built on the Cloudflare Cache API
 * (`caches.default`).
 *
 * The per-route `Cache-Control` headers (`middleware/cache.ts`) are inert at
 * the edge for a Workers route — Cloudflare does not cache a Worker's own
 * response by directive alone, so without this middleware every request runs
 * the worker and hits D1 (issue #1800). This wrapper reuses those headers as
 * the freshness contract: it stores any response the route already marked
 * `public, max-age>0` and serves it back to subsequent anonymous callers.
 *
 * Design notes:
 * - **Anonymous only.** Requests carrying `Authorization` or `Cookie` bypass
 *   the shared cache entirely (no read, no write) so a personalized/augmented
 *   response can never be stored, and a shared entry is never served to an
 *   authed caller. The hot traffic (MCP/CLI, SSR, anonymous browsers) is
 *   anonymous, so the win is preserved.
 * - **TTL is single-sourced.** `cache.put` derives expiry from the response's
 *   `Cache-Control: max-age`, so the route header stays the one freshness
 *   contract — no second TTL to keep in sync.
 * - **Vary-safe key.** The Workers Cache API keys on the request URL and does
 *   NOT honor the response `Vary` header. Routes using `varyOnAccept()` return
 *   markdown vs JSON for the same URL, so the cache key folds a coarse
 *   `md|json` discriminator (the only two shapes content negotiation
 *   distinguishes). Responses with any other `Vary` dimension are not stored.
 * - **Bustable.** Because the cache is worker-side, a future invalidation path
 *   can `caches.default.delete(key)` — complementing the existing
 *   `invalidateLatestCache` KV purge. (No purge wired yet; `max-age` is the
 *   safety net, same posture as the KV read-through.)
 *
 * Observability: sets `X-Edge-Cache: HIT | MISS | BYPASS` (distinct from the
 * KV read-through's `X-Cache`). Kill switch reuses the `CACHE_DISABLED` var /
 * `cache-disabled` Flagship flag — no new flag.
 */
export function edgeCache(): MiddlewareHandler<Env> {
  return async (c, next) => {
    // Only GET is cacheable. `caches` is absent outside the workerd runtime
    // (some unit-test harnesses) — fail open to the live handler.
    const cache = c.req.method === "GET" ? defaultCache() : undefined;
    if (!cache) {
      await next();
      return;
    }

    // Personalized/authed requests never touch the shared cache.
    const reqHeaders = c.req.raw.headers;
    if (reqHeaders.has("authorization") || reqHeaders.has("cookie")) {
      await next();
      c.res.headers.set("X-Edge-Cache", "BYPASS");
      return;
    }

    // Kill switch — same gate as the Cache-Control middleware.
    if (await flag(c.env.FLAGS, c.env.CACHE_DISABLED, FLAGS.cacheDisabled)) {
      await next();
      c.res.headers.set("X-Edge-Cache", "BYPASS");
      return;
    }

    const key = edgeCacheKey(c.req.raw);

    const hit = await cache.match(key).catch(() => undefined);
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set("X-Edge-Cache", "HIT");
      c.res = res;
      return;
    }

    await next();

    if (!isStorable(c.res)) {
      if (!c.res.headers.has("X-Edge-Cache")) c.res.headers.set("X-Edge-Cache", "BYPASS");
      return;
    }

    // Clone before tagging so the stored copy stays clean; the HIT path
    // overwrites `X-Edge-Cache` on serve anyway.
    const toStore = c.res.clone();
    c.res.headers.set("X-Edge-Cache", "MISS");

    const write = cache.put(key, toStore).catch(() => {
      // Fail open — next request misses again. `put` rejects on the same
      // conditions `isStorable` already screens (Set-Cookie, Vary:*, etc.),
      // so this is the residual-error net.
    });
    const waitUntil = getWaitUntil(c);
    if (waitUntil) waitUntil(write);
    else await write;
  };
}

/**
 * Stable cache key for a GET request: the request URL (all caller query params
 * preserved, just order-normalized) plus a `md|json` content-negotiation
 * discriminator. The discriminator rides a synthetic `/__edgecache/<fmt>` path
 * prefix rather than a query param so it can never collide with — or overwrite
 * — a param the caller actually sent. The synthetic URL is only ever a cache
 * key; it is never routed.
 */
/**
 * Build the Cache API key for a GET URL and Accept header. Exported for publish-
 * time invalidation alongside the KV read-through purge.
 */
export function buildEdgeCacheKey(url: string, accept: string | null): Request {
  const req = new Request(url, {
    method: "GET",
    headers: accept ? { Accept: accept } : {},
  });
  return edgeCacheKey(req);
}

function edgeCacheKey(req: Request): Request {
  const url = new URL(req.url);
  url.searchParams.sort();
  const fmt = acceptPrefersMarkdown(req.headers.get("accept")) ? "md" : "json";
  url.pathname = `/__edgecache/${fmt}${url.pathname}`;
  return new Request(url.toString(), { method: "GET" });
}

function isStorable(res: Response): boolean {
  if (res.status !== 200) return false;
  if (res.headers.has("set-cookie")) return false;

  const cc = (res.headers.get("cache-control") ?? "").toLowerCase();
  // A `no-store` / `no-cache` / `private` always wins, even alongside `public`
  // — never share-cache such a response.
  if (/(?:^|[\s,])(?:no-store|no-cache|private)(?:[\s,;=]|$)/.test(cc)) return false;
  if (!/(?:^|[\s,])public(?:[\s,;]|$)/.test(cc)) return false;
  const maxAge = parseMaxAge(cc);
  if (maxAge === null || maxAge <= 0) return false;

  // The key folds Accept (md|json); any other Vary dimension is unrepresented,
  // so refuse to store rather than risk serving the wrong variant.
  const vary = res.headers.get("vary");
  if (vary && !varyIsAcceptOnly(vary)) return false;

  return true;
}

function parseMaxAge(cacheControl: string): number | null {
  const match = /max-age=(\d+)/.exec(cacheControl);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function varyIsAcceptOnly(vary: string): boolean {
  const tokens = vary
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => t === "accept");
}

function getWaitUntil(c: Context): ((p: Promise<unknown>) => void) | undefined {
  try {
    return c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    // `executionCtx` throws when absent (tests) — run the write inline.
    return undefined;
  }
}
