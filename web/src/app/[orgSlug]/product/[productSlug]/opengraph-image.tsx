import { categoryDisplayName } from "@buildinternet/releases-core/categories";
import { api } from "@/lib/api";
import {
  OG_CONTENT_TYPE,
  OG_SIZE,
  formatCount,
  renderOgFallback,
  renderOgImage,
  resolveDisplayAvatarUrl,
} from "@/lib/og";

export const alt = "Product on releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

export default async function Image({
  params,
}: {
  params: Promise<{ orgSlug: string; productSlug: string }>;
}) {
  const { orgSlug, productSlug } = await params;
  try {
    const [product, orgDetail] = await Promise.all([
      api.productDetail({ orgSlug, productSlug }),
      api.orgDetail(orgSlug).catch(() => null),
    ]);
    const avatarUrl = await resolveDisplayAvatarUrl(product.avatarUrl, orgDetail);

    return renderOgImage({
      eyebrow: "Product",
      title: product.name,
      subtitle: orgDetail?.name ?? orgSlug,
      description: product.description ?? undefined,
      metrics: [
        { label: "Sources", value: formatCount(product.sources.length) },
        ...(product.category
          ? [{ label: "Category", value: categoryDisplayName(product.category) }]
          : []),
      ],
      avatarUrl,
    });
  } catch {
    return renderOgFallback();
  }
}
