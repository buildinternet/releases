import type { MetadataRoute } from "next";
import type { SitemapPayload } from "@buildinternet/releases-api-types";
import { orgMeetsIndexBar } from "./index-policy";

type SitemapOrg = SitemapPayload["orgs"][number];

/**
 * Whether an org (and so its products and sources) belongs in the sitemap.
 * Same bar the pages use for `noindex` (`orgMeetsIndexBar`). A payload from an
 * API that predates the `releaseCount` / `hasOverview` fields keeps every org,
 * so a deploy-order gap can't empty the sitemap.
 */
export function orgInSitemap(org: SitemapOrg): boolean {
  if (org.releaseCount === undefined && org.hasOverview === undefined) return true;
  return orgMeetsIndexBar(org);
}

/**
 * Pure construction of the org sitemap entries from a `/v1/sitemap` payload.
 * Each org that clears the index bar emits its bare URL, which leads with the
 * org overview. The Overview and Sources tabs are `noindex` and omitted, as is
 * `/:org/releases` (a 308 to the bare URL). Only a real `lastActivity` drives
 * lastmod; no fabricated `now` fallback.
 */
export function buildOrgSitemapEntries(
  orgs: SitemapPayload["orgs"],
  baseUrl: string,
): MetadataRoute.Sitemap {
  return orgs.filter(orgInSitemap).flatMap((org) => {
    const lastModified = org.lastActivity ? new Date(org.lastActivity) : undefined;
    return [
      {
        url: `${baseUrl}/${org.slug}`,
        lastModified,
        changeFrequency: "daily" as const,
        priority: 0.8,
      },
    ];
  });
}

/**
 * Pure construction of the product sitemap entries from a `/v1/sitemap`
 * payload. Side-effect-free (no Next.js app imports) so it's unit testable apart
 * from the sitemap route.
 *
 * Products live at the bare `/{org}/{slug}`, except in the single-product
 * collapse: an org with fewer than two products has no product URLs (they 308
 * to `/{org}`, see `collapsesToOrg`). `data.products` holds visible products
 * only, the same set the page counts, so the sitemap and the redirect agree.
 * Products are listed only when their org clears the index bar
 * (`orgInSitemap`).
 *
 * Source pages are never listed: they are `noindex` inputs to the org and
 * product views (see `NOINDEX_FOLLOW` in `index-policy.ts`).
 */
export function buildProductSitemapEntries(
  data: SitemapPayload,
  baseUrl: string,
): MetadataRoute.Sitemap {
  const indexedOrgs = new Set(data.orgs.filter(orgInSitemap).map((o) => o.slug));
  const productCountByOrg = new Map<string, number>();
  for (const p of data.products) {
    productCountByOrg.set(p.orgSlug, (productCountByOrg.get(p.orgSlug) ?? 0) + 1);
  }

  return data.products
    .filter((p) => indexedOrgs.has(p.orgSlug) && (productCountByOrg.get(p.orgSlug) ?? 0) > 1)
    .map((p) => ({
      url: `${baseUrl}/${p.orgSlug}/${p.slug}`,
      // No stored product updatedAt signal — omit lastmod rather than fake it.
      changeFrequency: "daily",
      priority: 0.7,
    }));
}
