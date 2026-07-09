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

export const alt = "Source on releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
// Off the ISR path (#2066): unbounded `[id]` cardinality means every render
// is a write and almost never a read. Cached by Vercel's Edge Network via
// OG_CDN_CACHE_HEADERS instead. The `/changelog` and `/highlights` sibling
// views (below) reuse this generator, so their own force-dynamic config
// rides along with it.
export const dynamic = "force-dynamic";

// Stays on REST (out of scope for #1978 slice 3 — see PR description): the
// `_lib/source-by-id.ts` helper other routes under this segment share is now
// GraphQL-backed and no longer carries `releaseCount` / `releasesLast30Days`,
// so this route calls `api.sourceById` directly instead.
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const source = await api.sourceById(id);
    const orgSlug = source.org?.slug;
    const orgDetail = orgSlug ? await api.orgDetail(orgSlug).catch(() => null) : null;
    const avatarUrl = await resolveAvatarUrl(orgDetail);
    const orgName = source.org?.name ?? orgSlug ?? "releases.sh";

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
