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
    const totalOrgs = detail.orgs.length;
    const previewNames = detail.orgs
      .slice(0, 4)
      .map((o) => o.name)
      .join(", ");
    const subtitle =
      totalOrgs > 4 ? `${previewNames} + ${totalOrgs - 4} more` : previewNames || undefined;

    return renderOgImage({
      eyebrow: "Collection",
      title: detail.name,
      subtitle,
      description: detail.description ?? undefined,
      metrics: [{ label: "Orgs", value: formatCount(detail.orgs.length) }],
    });
  } catch {
    return renderOgFallback();
  }
}
