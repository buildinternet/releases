import { api } from "@/lib/api";
import {
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
export const revalidate = 86400;

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
