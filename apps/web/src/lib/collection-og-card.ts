import { api } from "@/lib/api";
import { formatCount, type OgTemplateProps } from "@/lib/og";

/**
 * Shared collection OG card content. Used by the file-convention
 * `collections/[slug]/opengraph-image.tsx` and the stable
 * `/api/og/collection/[slug]` route that the collection's weekly digest pages
 * point their `og:image` at (one card per collection, not per week).
 *
 * Throws on any lookup failure; callers decide how to render + cache the fallback.
 */
export async function buildCollectionOgProps(slug: string): Promise<OgTemplateProps> {
  const detail = await api.collectionDetail(slug);
  const totalMembers = detail.members.length;
  const previewNames = detail.members
    .slice(0, 4)
    .map((m) => m.name)
    .join(", ");
  const subtitle =
    totalMembers > 4 ? `${previewNames} + ${totalMembers - 4} more` : previewNames || undefined;

  return {
    eyebrow: "Collection",
    title: detail.name,
    subtitle,
    description: detail.description ?? undefined,
    metrics: [{ label: "Members", value: formatCount(totalMembers) }],
  };
}
