import type { MetadataRoute } from "next";

/**
 * Serialize `MetadataRoute.Sitemap` entries to a sitemap XML document.
 *
 * Next's metadata `sitemap.ts` convention only produces the single
 * `/sitemap.xml` (and `generateSitemaps` emits no index file), so the
 * per-page-class sitemaps (`sitemap-orgs.xml`, `sitemap-collections.xml`)
 * are plain named routes that render the same entry shape through this
 * helper — keeping one serializer and letting the entry builders stay
 * shared with the main sitemap.
 */
export function renderSitemapXml(entries: MetadataRoute.Sitemap): string {
  const urls = entries
    .map((entry) => {
      const fields = [`    <loc>${xmlEscape(entry.url)}</loc>`];
      if (entry.lastModified != null) {
        const iso =
          entry.lastModified instanceof Date
            ? entry.lastModified.toISOString()
            : entry.lastModified;
        fields.push(`    <lastmod>${xmlEscape(iso)}</lastmod>`);
      }
      if (entry.changeFrequency) {
        fields.push(`    <changefreq>${entry.changeFrequency}</changefreq>`);
      }
      if (entry.priority != null) {
        fields.push(`    <priority>${entry.priority}</priority>`);
      }
      return `  <url>\n${fields.join("\n")}\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
