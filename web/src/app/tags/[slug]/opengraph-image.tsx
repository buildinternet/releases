import { api } from "@/lib/api";
import {
  OG_CDN_CACHE_HEADERS,
  OG_CONTENT_TYPE,
  OG_SIZE,
  formatCount,
  renderOgFallback,
  renderOgImage,
} from "@/lib/og";

export const alt = "Tag on releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
// Off the ISR path (#2066): unbounded `[slug]` cardinality means every render
// is a write and almost never a read. Cached by Vercel's Edge Network via
// OG_CDN_CACHE_HEADERS instead.
export const dynamic = "force-dynamic";

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const detail = await api.tagDetail(slug);
    return renderOgImage(
      {
        eyebrow: "Tag",
        title: detail.name,
        description: `Organizations and products tagged ${detail.name}.`,
        metrics: [
          { label: "Orgs", value: formatCount(detail.orgs.length) },
          { label: "Products", value: formatCount(detail.products.length) },
        ],
      },
      { headers: OG_CDN_CACHE_HEADERS },
    );
  } catch {
    return renderOgFallback({ headers: OG_CDN_CACHE_HEADERS });
  }
}
