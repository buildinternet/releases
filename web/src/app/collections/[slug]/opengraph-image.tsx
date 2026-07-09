import { api } from "@/lib/api";
import {
  OG_CDN_CACHE_HEADERS,
  OG_CONTENT_TYPE,
  OG_SIZE,
  formatCount,
  renderOgFallback,
  renderOgImage,
} from "@/lib/og";

export const alt = "Collection on releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
// Off the ISR path (#2066): unbounded `[slug]` cardinality means every render
// is a write and almost never a read. Cached by Vercel's Edge Network via
// OG_CDN_CACHE_HEADERS instead.
export const dynamic = "force-dynamic";

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const detail = await api.collectionDetail(slug);
    const totalMembers = detail.members.length;
    const previewNames = detail.members
      .slice(0, 4)
      .map((m) => m.name)
      .join(", ");
    const subtitle =
      totalMembers > 4 ? `${previewNames} + ${totalMembers - 4} more` : previewNames || undefined;

    return renderOgImage(
      {
        eyebrow: "Collection",
        title: detail.name,
        subtitle,
        description: detail.description ?? undefined,
        metrics: [{ label: "Members", value: formatCount(totalMembers) }],
      },
      { headers: OG_CDN_CACHE_HEADERS },
    );
  } catch {
    return renderOgFallback({ headers: OG_CDN_CACHE_HEADERS });
  }
}
