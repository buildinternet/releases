import { categoryDisplayName } from "@buildinternet/releases-core/categories";
import { api } from "@/lib/api";
import {
  OG_CONTENT_TYPE,
  OG_SIZE,
  formatCount,
  renderOgFallback,
  renderOgImage,
  resolveAvatarUrl,
  resolveDisplayAvatarUrl,
} from "@/lib/og";

export const alt = "Releases on releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

export default async function Image({
  params,
}: {
  params: Promise<{ orgSlug: string; slug: string }>;
}) {
  const { orgSlug, slug } = await params;
  try {
    const resolved = await api.resolve({ orgSlug, slug });

    if (resolved.kind === "product") {
      const product = resolved.product;
      const orgDetail = await api.orgDetail(orgSlug).catch(() => null);
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
    }

    const source = resolved.source;
    const orgDetail = await api.orgDetail(orgSlug).catch(() => null);
    const avatarUrl = await resolveAvatarUrl(orgDetail);
    const orgName = source.org?.name ?? orgDetail?.name ?? orgSlug;

    const metrics = [
      { label: "Releases", value: formatCount(source.releaseCount) },
      { label: "Last 30d", value: formatCount(source.releasesLast30Days) },
    ];
    if (source.latestVersion) {
      metrics.push({ label: "Latest", value: source.latestVersion });
    }

    return renderOgImage({
      eyebrow: "Source",
      title: source.name,
      subtitle: orgName,
      metrics,
      avatarUrl,
    });
  } catch {
    return renderOgFallback();
  }
}
