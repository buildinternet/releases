import { categoryDisplayName } from "@buildinternet/releases-core/categories";
import { api } from "@/lib/api";
import { formatCount, resolveAvatarUrl, type OgTemplateProps } from "@/lib/og";

/**
 * Shared org OG card content.
 *
 * Two routes render this same design and must not drift:
 * - `web/src/app/[orgSlug]/(org)/opengraph-image.tsx` — the file-convention
 *   route Next serves at a build-hashed URL (not hand-constructible).
 * - `web/src/app/api/og/org/[slug]/route.tsx` — a stable, explicitly
 *   addressable URL. Releases point their `og:image` at THIS route instead of
 *   rendering a per-release card: ~40k releases means ~40k distinct OG URLs,
 *   which no cache layer can ever get a hit against, while there are only
 *   ~100 orgs.
 *
 * Throws on any lookup failure (unknown slug, upstream error); callers decide
 * how to render + cache the fallback.
 */
export async function buildOrgOgProps(orgSlug: string): Promise<OgTemplateProps> {
  const org = await api.orgDetail(orgSlug);
  const avatarUrl = await resolveAvatarUrl(org);
  const description =
    org.description ?? (org.domain ? `Changelog activity from ${org.domain}` : undefined);
  return {
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
  };
}
