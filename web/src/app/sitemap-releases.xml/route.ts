import { NextResponse } from "next/server";
import { api, ApiSetupError } from "@/lib/api";
import { getStaticBaseUrl } from "@/lib/base-url";
import { releasePath } from "@buildinternet/releases-core/release-slug";

// Render on-demand (not during `next build`), matching the main sitemap —
// a cold worker / slow D1 can't time out the Vercel export.
export const dynamic = "force-dynamic";
export const revalidate = 3600;

const BASE_URL = getStaticBaseUrl();

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Curated, importance-gated release sitemap (#1181 scoped down, WS2). A
 * second, named sitemap (not `generateSitemaps`, which emits no index file)
 * keeps this GSC-submittable independent of the main `sitemap.xml`. One
 * `<url>` per release from `GET /v1/sitemap/releases`; `<loc>` is the
 * slugged canonical URL (`releasePath()`), `<lastmod>` is `fetchedAt`.
 * `changefreq`/`priority` are deliberately omitted — Google ignores them.
 */
export async function GET() {
  let releases: Awaited<ReturnType<typeof api.sitemapReleases>>["releases"] = [];
  try {
    const payload = await api.sitemapReleases();
    releases = payload.releases;
  } catch (err) {
    if (!(err instanceof ApiSetupError)) throw err;
  }

  const urlEntries = releases
    .map((r) => {
      const loc = `${BASE_URL}${releasePath(r)}`;
      return `  <url>\n    <loc>${xmlEscape(loc)}</loc>\n    <lastmod>${xmlEscape(r.fetchedAt)}</lastmod>\n  </url>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries}\n</urlset>\n`;

  return new NextResponse(xml, {
    headers: { "Content-Type": "application/xml" },
  });
}
