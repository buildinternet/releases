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
} from "@/lib/og";

export const alt = "Organization on releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
// Off the ISR path (#2066): unbounded `[orgSlug]` cardinality means every
// render is a write and almost never a read. Cached by Vercel's Edge Network
// via OG_CDN_CACHE_HEADERS instead. The `/releases` and `/sources` sibling
// views (below) reuse this generator, so their own force-dynamic config rides
// along with it.
export const dynamic = "force-dynamic";

export default async function Image({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  try {
    const org = await api.orgDetail(orgSlug);
    const avatarUrl = await resolveAvatarUrl(org);
    const description =
      org.description ?? (org.domain ? `Changelog activity from ${org.domain}` : undefined);
    return renderOgImage(
      {
        eyebrow: "Organization",
        title: org.name,
        subtitle: org.category ? categoryDisplayName(org.category) : undefined,
        description,
        metrics: [
          { label: "Sources", value: formatCount(org.sourceCount) },
          { label: "Releases", value: formatCount(org.releaseCount) },
          { label: "Last 30d", value: formatCount(org.releasesLast30Days) },
        ],
        avatarUrl,
      },
      { headers: OG_CDN_CACHE_HEADERS },
    );
  } catch {
    return renderOgFallback({ headers: OG_CDN_CACHE_HEADERS });
  }
}
