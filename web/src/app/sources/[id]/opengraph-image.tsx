import { api } from "@/lib/api";
import {
  OG_CONTENT_TYPE,
  OG_SIZE,
  formatCount,
  renderOgFallback,
  renderOgImage,
  resolveAvatarUrl,
} from "@/lib/og";
import { getSourceById } from "./_lib/source-by-id";

export const alt = "Source on releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const source = await getSourceById(id);
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
