import { api } from "@/lib/api";
import {
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
export const revalidate = 86400;

export default async function Image({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  try {
    const org = await api.orgDetail(orgSlug);
    const avatarUrl = await resolveAvatarUrl(org);
    const description =
      org.description ?? (org.domain ? `Changelog activity from ${org.domain}` : undefined);
    return renderOgImage({
      eyebrow: "Organization",
      title: org.name,
      subtitle: org.category ? org.category : undefined,
      description,
      metrics: [
        { label: "Sources", value: formatCount(org.sourceCount) },
        { label: "Releases", value: formatCount(org.releaseCount) },
        { label: "Last 30d", value: formatCount(org.releasesLast30Days) },
      ],
      avatarUrl,
    });
  } catch {
    return renderOgFallback();
  }
}
