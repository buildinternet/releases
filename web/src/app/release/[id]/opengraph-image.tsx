import { api } from "@/lib/api";
import { parseReleaseParam } from "@buildinternet/releases-core/release-slug";
import {
  OG_CACHE_FALLBACK,
  OG_CACHE_SUCCESS,
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
// force-dynamic (not `revalidate`) so this route's own Cache-Control ships
// verbatim (#2066): a successful render is edge-cached 24h via OG_CACHE_SUCCESS,
// but the catch-branch fallback returns no-store so a transient api.release()
// failure can't pin the generic card onto a release for a day. With #2066
// mirroring release OG images to R2 at ingest, only unmirrored releases reach
// this live route at all, so re-rendering per edge-miss is a non-issue.
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
      { headers: { ...OG_CACHE_SUCCESS } },
    );
  } catch {
    return renderOgFallback({ headers: { ...OG_CACHE_FALLBACK } });
  }
}
