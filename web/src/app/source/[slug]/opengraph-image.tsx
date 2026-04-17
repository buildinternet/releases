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

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  try {
    const source = await api.sourceDetail(slug);
    const orgDetail = source.org
      ? await api.orgDetail(source.org.slug).catch(() => null)
      : null;
    const avatarUrl = await resolveAvatarUrl(orgDetail);

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
      subtitle: source.org ? source.org.name : undefined,
      metrics,
      avatarUrl,
    });
  } catch {
    return renderOgFallback();
  }
}
