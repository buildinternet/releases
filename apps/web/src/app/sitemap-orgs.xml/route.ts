import { NextResponse } from "next/server";
import { api, ApiSetupError } from "@/lib/api";
import { getStaticBaseUrl } from "@/lib/base-url";
import { buildEntitySitemapEntries, buildOrgSitemapEntries } from "@/lib/sitemap-entries";
import { renderSitemapXml } from "@/lib/sitemap-xml";

// Render on-demand (not during `next build`), matching the main sitemap —
// a cold worker / slow D1 can't time out the Vercel export.
export const dynamic = "force-dynamic";
export const revalidate = 3600;

const BASE_URL = getStaticBaseUrl();

/**
 * Registry-surface sitemap: org pages (+ overview/sources tabs), products,
 * and sources. Split from the main `sitemap.xml` purely for GSC
 * observability — each submitted sitemap gets its own page-indexing
 * breakdown, so "are the org pages indexing?" is a number rather than a
 * guess. The URL set is identical to what the main sitemap used to carry.
 */
export async function GET() {
  let entries: ReturnType<typeof buildOrgSitemapEntries> = [];
  try {
    const data = await api.sitemap();
    entries = [
      ...buildOrgSitemapEntries(data.orgs, BASE_URL),
      ...buildEntitySitemapEntries(data, BASE_URL),
    ];
  } catch (err) {
    if (!(err instanceof ApiSetupError)) throw err;
  }

  return new NextResponse(renderSitemapXml(entries), {
    headers: { "Content-Type": "application/xml" },
  });
}
