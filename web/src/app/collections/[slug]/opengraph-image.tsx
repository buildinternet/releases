import { api } from "@/lib/api";
import { OG_CONTENT_TYPE, OG_SIZE, formatCount, renderOgFallback, renderOgImage } from "@/lib/og";

export const alt = "Collection on releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

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

    return renderOgImage({
      eyebrow: "Collection",
      title: detail.name,
      subtitle,
      description: detail.description ?? undefined,
      metrics: [{ label: "Members", value: formatCount(totalMembers) }],
    });
  } catch {
    return renderOgFallback();
  }
}
