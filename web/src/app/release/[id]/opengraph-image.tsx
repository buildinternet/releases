import { api } from "@/lib/api";
import { parseReleaseParam } from "@buildinternet/releases-core/release-slug";
import {
  OG_CDN_CACHE_HEADERS,
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
// Off the ISR path (#2066): unbounded `[id]` cardinality means every render
// is a write and almost never a read. Cached by Vercel's Edge Network via
// OG_CDN_CACHE_HEADERS instead.
export const dynamic = "force-dynamic";

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawParam } = await params;
  const { id } = parseReleaseParam(rawParam);
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
      : stripMarkdown(release.summary ?? release.content) || undefined;
    const published = formatDate(release.publishedAt);

    return renderOgImage(
      {
        eyebrow: "Release",
        title: heading,
        subtitle,
        description,
        metrics: published ? [{ label: "Published", value: published }] : [],
        avatarUrl,
        heroImage,
      },
      { headers: OG_CDN_CACHE_HEADERS },
    );
  } catch {
    return renderOgFallback({ headers: OG_CDN_CACHE_HEADERS });
  }
}
