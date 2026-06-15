import type { MetadataRoute } from "next";
import type { SitemapPayload } from "@buildinternet/releases-api-types";

/**
 * Pure construction of the product + source sitemap entries from a
 * `/v1/sitemap` payload. Lives in its own side-effect-free module (no Next.js
 * app imports, no docs/flags machinery) so the #1190 shadow-routing logic is
 * unit testable independent of the sitemap route's module-load side effects.
 *
 * Products are canonical at the bare `/[org]/[slug]` (#1190). A source whose
 * slug collides with a product in the same org is "shadowed" — the product
 * wins the bare URL via product-first resolution, so the source's canonical
 * home is `/sources/:id` (no sub-tabs). Non-shadowed and orphan sources keep
 * their bare URL plus `highlights`/`changelog` sub-tabs. If a shadowed source
 * is missing an `id` (stale/cached payload from an older worker), it degrades
 * to the bare URL + sub-tabs rather than emitting `/sources/undefined`.
 *
 * Single-product orgs are skipped: the org page IS that product's feed, so the
 * product page 308-redirects to `/[org]` (`org.products.length <= 1` collapse,
 * web/src/app/[orgSlug]/[slug]/page.tsx). Emitting its bare URL here would put
 * a redirecting URL in the sitemap; the `/[org]` org entry already covers the
 * content. Shadow detection (`productKeys`) still uses the FULL product set so
 * a single-product org's colliding source keeps routing to `/sources/:id`
 * instead of falling back to the redirecting bare URL (#1636).
 */
export function buildEntitySitemapEntries(
  data: SitemapPayload,
  baseUrl: string,
): MetadataRoute.Sitemap {
  const now = new Date();

  // Set of "orgSlug/slug" that a product owns. These slugs win the bare
  // /[org]/[slug] URL via product-first resolution (#1190), so any source
  // whose slug collides in the same org is "shadowed" and must be listed at
  // /sources/:id instead of the bare path. Built from the FULL product set —
  // independent of the single-product emit filter below — so shadow routing
  // stays correct even when a product entry is omitted (#1636).
  const productKeys = new Set(data.products.map((p) => `${p.orgSlug}/${p.slug}`));

  // Per-org product count, mirroring the page's `org.products.length` redirect
  // condition. This payload and org-detail both read the same `productsActive`
  // view, so the count matches the page's collapse rule exactly (#1636).
  const productCountByOrg = new Map<string, number>();
  for (const p of data.products) {
    productCountByOrg.set(p.orgSlug, (productCountByOrg.get(p.orgSlug) ?? 0) + 1);
  }

  // Products → bare /[org]/[slug] (was /[org]/product/[slug], #1190). Skip
  // single-product orgs whose bare product URL 308-redirects to /[org] (#1636).
  const productEntries: MetadataRoute.Sitemap = data.products
    .filter((p) => (productCountByOrg.get(p.orgSlug) ?? 0) > 1)
    .map((p) => ({
      url: `${baseUrl}/${p.orgSlug}/${p.slug}`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.7,
    }));

  // Sources: shadowed (slug collides with a product in the same org) → /sources/:id
  // with no sub-tabs; non-shadowed/orphan sources keep the bare URL + sub-tabs.
  const sourceEntries: MetadataRoute.Sitemap = data.sources.flatMap((s) => {
    const lastModified = s.latestDate ? new Date(s.latestDate) : now;
    const shadowed = productKeys.has(`${s.orgSlug}/${s.slug}`);
    if (shadowed && s.id) {
      return [
        {
          url: `${baseUrl}/sources/${s.id}`,
          lastModified,
          changeFrequency: "daily" as const,
          priority: 0.7,
        },
      ];
    }
    const base = `${baseUrl}/${s.orgSlug}/${s.slug}`;
    const entries: MetadataRoute.Sitemap = [
      {
        url: base,
        lastModified,
        changeFrequency: "daily" as const,
        priority: 0.7,
      },
    ];
    if (s.hasHighlights) {
      entries.push({
        url: `${base}/highlights`,
        lastModified,
        changeFrequency: "weekly" as const,
        priority: 0.6,
      });
    }
    if (s.hasChangelog) {
      entries.push({
        url: `${base}/changelog`,
        lastModified,
        changeFrequency: "weekly" as const,
        priority: 0.6,
      });
    }
    return entries;
  });

  return [...productEntries, ...sourceEntries];
}
