import type { MetadataRoute } from "next";
import { NextResponse } from "next/server";
import { api, ApiSetupError } from "@/lib/api";
import { getStaticBaseUrl } from "@/lib/base-url";
import { renderSitemapXml } from "@/lib/sitemap-xml";

// Render on-demand (not during `next build`), matching the main sitemap —
// a cold worker / slow D1 can't time out the Vercel export.
export const dynamic = "force-dynamic";
export const revalidate = 3600;

const BASE_URL = getStaticBaseUrl();

/**
 * Editorial-surface sitemap: collection pages + weekly digest permalinks.
 * Split from the main `sitemap.xml` purely for GSC observability (see
 * sitemap-orgs.xml). The URL set is identical to what the main sitemap
 * used to carry.
 */
export async function GET() {
  let entries: MetadataRoute.Sitemap = [];
  try {
    const data = await api.sitemap();

    const collectionEntries: MetadataRoute.Sitemap = (data.collections ?? []).map((co) => ({
      url: `${BASE_URL}/collections/${co.slug}`,
      lastModified: new Date(co.updatedAt),
      changeFrequency: "weekly",
      priority: 0.6,
    }));

    // Weekly digest permalinks — the net-new editorial surface (WS3).
    // `lastModified` = generation time; digests are immutable-ish once
    // written, so no fabricated "now" fallback.
    const digestEntries: MetadataRoute.Sitemap = (data.digests ?? []).map((d) => ({
      url: `${BASE_URL}/collections/${d.collectionSlug}/digest/${d.weekStart}`,
      lastModified: new Date(d.generatedAt),
      changeFrequency: "monthly" as const,
      priority: 0.5,
    }));

    entries = [...collectionEntries, ...digestEntries];
  } catch (err) {
    if (!(err instanceof ApiSetupError)) throw err;
  }

  return new NextResponse(renderSitemapXml(entries), {
    headers: { "Content-Type": "application/xml" },
  });
}
