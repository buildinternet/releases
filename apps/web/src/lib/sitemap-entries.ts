import type { MetadataRoute } from "next";
import type { SitemapPayload } from "@buildinternet/releases-api-types";

/**
 * Pure construction of the `/updates/<date>` sitemap entries from a list of
 * release `publishedAt` values. One entry per DISTINCT date, not per release
 * — the naive per-release map used to emit one duplicate `/updates/<date>`
 * URL for every release published that day (~43 duplicates in the live
 * sitemap for one moderately active day). Dedupe via a `Set` before mapping.
 * `publishedAtValues` may contain nulls/malformed strings; anything that
 * doesn't match `YYYY-MM-DD` after slicing is dropped.
 */
export function buildUpdatesSitemapEntries(
  publishedAtValues: (string | null | undefined)[],
  baseUrl: string,
): MetadataRoute.Sitemap {
  const dates = new Set(
    publishedAtValues
      .map((v) => (v ?? "").slice(0, 10))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
  );
  return [...dates].map((d) => ({
    url: `${baseUrl}/updates/${d}`,
    lastModified: new Date(`${d}T12:00:00Z`),
    changeFrequency: "monthly" as const,
    priority: 0.5,
  }));
}

/**
 * Pure construction of the org sitemap entries from a `/v1/sitemap` payload.
 * Each org emits the bare URL (Releases feed — the default landing) plus
 * Overview and Sources tabs. `/:org/releases` 308s to the bare URL and is
 * deliberately omitted so the sitemap only lists canonical paths. Only a real
 * `lastActivity` drives lastmod; no fabricated `now` fallback.
 */
export function buildOrgSitemapEntries(
  orgs: SitemapPayload["orgs"],
  baseUrl: string,
): MetadataRoute.Sitemap {
  return orgs.flatMap((org) => {
    const lastModified = org.lastActivity ? new Date(org.lastActivity) : undefined;
    return [
      {
        url: `${baseUrl}/${org.slug}`,
        lastModified,
        changeFrequency: "daily" as const,
        priority: 0.8,
      },
      {
        url: `${baseUrl}/${org.slug}/overview`,
        lastModified,
        changeFrequency: "weekly" as const,
        priority: 0.6,
      },
      {
        url: `${baseUrl}/${org.slug}/sources`,
        lastModified,
        changeFrequency: "weekly" as const,
        priority: 0.6,
      },
    ];
  });
}

/**
 * Pure construction of the product + source sitemap entries from a
 * `/v1/sitemap` payload. Side-effect-free (no Next.js app imports) so it's unit
 * testable apart from the sitemap route.
 *
 * One rule: products and sources live at the bare `/{org}/{slug}`. Product and
 * source slugs never collide within an org (the API rejects it), so the two
 * never compete for a URL. The single exception is the single-product collapse:
 * an org with fewer than two products has no product URLs (they 308 to
 * `/{org}`, see `collapsesToOrg`). `data.products` holds visible products only,
 * the same set the page counts, so the sitemap and the redirect agree.
 */
export function buildEntitySitemapEntries(
  data: SitemapPayload,
  baseUrl: string,
): MetadataRoute.Sitemap {
  const productCountByOrg = new Map<string, number>();
  for (const p of data.products) {
    productCountByOrg.set(p.orgSlug, (productCountByOrg.get(p.orgSlug) ?? 0) + 1);
  }

  const productEntries: MetadataRoute.Sitemap = data.products
    .filter((p) => (productCountByOrg.get(p.orgSlug) ?? 0) > 1)
    .map((p) => ({
      url: `${baseUrl}/${p.orgSlug}/${p.slug}`,
      // No stored product updatedAt signal — omit lastmod rather than fake it.
      changeFrequency: "daily",
      priority: 0.7,
    }));

  const sourceEntries: MetadataRoute.Sitemap = data.sources.flatMap((s) => {
    // Only a real latestDate drives lastmod; no fabricated `now` fallback.
    const lastModified = s.latestDate ? new Date(s.latestDate) : undefined;
    const base = `${baseUrl}/${s.orgSlug}/${s.slug}`;
    const entries: MetadataRoute.Sitemap = [
      { url: base, lastModified, changeFrequency: "daily" as const, priority: 0.7 },
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
