import { api } from "@/lib/api";
import {
  OG_CONTENT_TYPE,
  OG_SIZE,
  formatDate,
  renderOgFallback,
  renderOgImage,
  resolveAvatarUrl,
  resolveHeroImage,
  stripMarkdown,
} from "@/lib/og";

export const alt = "Release on releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const release = await api.release(id);
    const orgDetail = release.org ? await api.orgDetail(release.org.slug).catch(() => null) : null;

    const [avatarUrl, heroImage] = await Promise.all([
      resolveAvatarUrl(orgDetail),
      resolveHeroImage(release.media),
    ]);

    const heading = release.version ?? release.title;
    const orgName = release.org?.name ?? null;
    const sourceName = release.sourceName;
    const subtitle = orgName && orgName !== sourceName ? `${sourceName} · ${orgName}` : sourceName;
    const description = heroImage
      ? undefined
      : stripMarkdown(release.contentSummary ?? release.content) || undefined;
    const published = formatDate(release.publishedAt);

    return renderOgImage({
      eyebrow: "Release",
      title: heading,
      subtitle,
      description,
      metrics: published ? [{ label: "Published", value: published }] : [],
      avatarUrl,
      heroImage,
    });
  } catch {
    return renderOgFallback();
  }
}
