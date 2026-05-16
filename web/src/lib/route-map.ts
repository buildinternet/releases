/**
 * Map a pathname to the internal Next.js route that produces its markdown
 * representation, or `null` when no such representation exists (→ the
 * caller should answer 406).
 *
 * First match wins, and order is load-bearing: the product rule must run
 * before the generic two-segment fallback or `/foo/product/bar` would
 * silently route to `/api/format/foo/product`.
 */
export function routeMap(pathname: string): string | null {
  if (pathname === "/") return "/api/format/home";
  if (pathname === "/docs") return "/api/docs/index";
  if (pathname.startsWith("/docs/")) {
    return `/api/docs/${pathname.slice("/docs/".length)}`;
  }
  if (pathname.startsWith("/source/")) {
    return `/api/format${pathname}`;
  }

  const staticSlug = pathname.slice(1);
  if (STATIC_PAGES.has(staticSlug)) return `/api/format/page/${staticSlug}`;

  const release = pathname.match(/^\/release\/([^/]+)$/);
  if (release) return `/api/format/release/${release[1]}`;

  const product = pathname.match(/^\/([^/]+)\/product\/([^/]+)$/);
  if (product) return `/api/format/${product[1]}/product/${product[2]}`;

  const parts = pathname.slice(1).split("/").filter(Boolean);
  if (parts.length === 0) return null;
  if (RESERVED.has(parts[0])) return null;
  if (parts.length === 1 || parts.length === 2) {
    return `/api/format/${parts.join("/")}`;
  }
  return null;
}

export const STATIC_PAGES = new Set(["privacy", "terms", "security", "search", "status"]);

const RESERVED = new Set([
  "admin",
  "api",
  "_next",
  ".well-known",
  "favicon.ico",
  "robots.txt",
  "sitemap.xml",
  "llms.txt",
  "llms-full.txt",
  "manifest.json",
  "sw.js",
  "opengraph-image",
]);
