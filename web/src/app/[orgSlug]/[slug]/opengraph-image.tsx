import { categoryDisplayName } from "@buildinternet/releases-core/categories";
import { api } from "@/lib/api";
import {
  OG_CDN_CACHE_HEADERS,
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
// Off the ISR path (#2066): unbounded `[orgSlug]/[slug]` cardinality means
// every render is a write and almost never a read. Cached by Vercel's Edge
// Network via OG_CDN_CACHE_HEADERS instead. The `/changelog` and
// `/highlights` sibling views reuse this generator, so their own
// force-dynamic config rides along with it.
export const dynamic = "force-dynamic";

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

      return renderOgImage(
        {
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
        },
        { headers: OG_CDN_CACHE_HEADERS },
      );
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

    return renderOgImage(
      {
        eyebrow: "Source",
        title: source.name,
        subtitle: orgName,
        metrics,
        avatarUrl,
      },
      { headers: OG_CDN_CACHE_HEADERS },
    );
  } catch {
    return renderOgFallback({ headers: OG_CDN_CACHE_HEADERS });
  }
}
