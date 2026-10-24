import { api } from "@/lib/api";
import {
  OG_CONTENT_TYPE,
  OG_SIZE,
  formatCount,
  renderOgFallback,
  renderOgImage,
  resolveAvatarUrl,
} from "@/lib/og";
import { enableOnDemandIsr } from "@/lib/static-params";

export const alt = "Source on Release Notes Index";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;
export const generateStaticParams = enableOnDemandIsr;

// Stays on REST: the shared `_lib/source-by-id.ts` helper is GraphQL-backed and
// doesn't carry `releaseCount` / `releasesLast30Days`.
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const source = await api.sourceById(id);
    const orgSlug = source.org?.slug;
    const orgDetail = orgSlug ? await api.orgDetail(orgSlug).catch(() => null) : null;
    const avatarUrl = await resolveAvatarUrl(orgDetail);
    const orgName = source.org?.name ?? orgSlug ?? "Releases Index";

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
