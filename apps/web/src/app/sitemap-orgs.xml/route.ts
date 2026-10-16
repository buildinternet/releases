import { NextResponse } from "next/server";
import { api, ApiSetupError } from "@/lib/api";
import { getStaticBaseUrl } from "@/lib/base-url";
import {
  buildProductSitemapEntries,
  buildOrgSitemapEntries,
  buildSourceDatasetSitemapEntries,
} from "@/lib/sitemap-entries";
import { renderSitemapXml } from "@/lib/sitemap-xml";

// Render on-demand (not during `next build`), matching the main sitemap —
// a cold worker / slow D1 can't time out the Vercel export.
export const dynamic = "force-dynamic";
export const revalidate = 3600;

const BASE_URL = getStaticBaseUrl();

/**
 * Registry-surface sitemap: org pages, products, and the three dataset pilot
 * source histories. Other source pages stay `noindex`. Split from `sitemap.xml` so
 * each submitted sitemap gets its own page-indexing breakdown.
 */
export async function GET() {
  let entries: ReturnType<typeof buildOrgSitemapEntries> = [];
  try {
    const data = await api.sitemap();
    entries = [
      ...buildOrgSitemapEntries(data.orgs, BASE_URL),
      ...buildProductSitemapEntries(data, BASE_URL),
      ...buildSourceDatasetSitemapEntries(data, BASE_URL),
    ];
  } catch (err) {
    if (!(err instanceof ApiSetupError)) throw err;
  }

  return new NextResponse(renderSitemapXml(entries), {
    headers: { "Content-Type": "application/xml" },
  });
}
