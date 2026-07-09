import { categoryDisplayName, isValidCategory } from "@buildinternet/releases-core/categories";
import { api } from "@/lib/api";
import {
  OG_CDN_CACHE_HEADERS,
  OG_CONTENT_TYPE,
  OG_SIZE,
  formatCount,
  renderOgFallback,
  renderOgImage,
} from "@/lib/og";

export const alt = "Category on releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
// Off the ISR path (#2066): unbounded `[slug]` cardinality means every render
// is a write and almost never a read. Cached by Vercel's Edge Network via
// OG_CDN_CACHE_HEADERS instead.
export const dynamic = "force-dynamic";

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isValidCategory(slug)) return renderOgFallback({ headers: OG_CDN_CACHE_HEADERS });
  try {
    const detail = await api.categoryDetail(slug);
    const title = categoryDisplayName(detail.slug);
    const totalOrgs = detail.orgs.length;
    const previewNames = detail.orgs
      .slice(0, 4)
      .map((o) => o.name)
      .join(", ");
    const subtitle =
      totalOrgs > 4 ? `${previewNames} + ${totalOrgs - 4} more` : previewNames || undefined;

    return renderOgImage(
      {
        eyebrow: "Category",
        title,
        subtitle,
        description: `Aggregated releases from organizations and products in the ${title} category.`,
        metrics: [
          { label: "Orgs", value: formatCount(totalOrgs) },
          { label: "Products", value: formatCount(detail.products.length) },
        ],
      },
      { headers: OG_CDN_CACHE_HEADERS },
    );
  } catch {
    return renderOgFallback({ headers: OG_CDN_CACHE_HEADERS });
  }
}
