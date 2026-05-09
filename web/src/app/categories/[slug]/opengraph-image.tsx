import { categoryDisplayName } from "@buildinternet/releases-core/categories";
import { api } from "@/lib/api";
import { OG_CONTENT_TYPE, OG_SIZE, formatCount, renderOgFallback, renderOgImage } from "@/lib/og";

export const alt = "Category on releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const detail = await api.categoryDetail(slug);
    const title = categoryDisplayName(detail.slug);
    return renderOgImage({
      eyebrow: "Category",
      title,
      description: `Organizations and products in the ${title} category.`,
      metrics: [
        { label: "Orgs", value: formatCount(detail.orgs.length) },
        { label: "Products", value: formatCount(detail.products.length) },
      ],
    });
  } catch {
    return renderOgFallback();
  }
}
