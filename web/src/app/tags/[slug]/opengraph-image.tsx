import { api } from "@/lib/api";
import { OG_CONTENT_TYPE, OG_SIZE, formatCount, renderOgFallback, renderOgImage } from "@/lib/og";

export const alt = "Tag on releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const detail = await api.tagDetail(slug);
    return renderOgImage({
      eyebrow: "Tag",
      title: detail.name,
      description: `Organizations and products tagged ${detail.name}.`,
      metrics: [
        { label: "Orgs", value: formatCount(detail.orgs.length) },
        { label: "Products", value: formatCount(detail.products.length) },
      ],
    });
  } catch {
    return renderOgFallback();
  }
}
