import type { Metadata } from "next";
import { docMdPath, docPath, type DocFrontmatter } from "@/lib/docs";
import { OG_CONTENT_TYPE, OG_SIZE } from "@/lib/og-helpers";
import { docOgImageUrl, ogImageFields, siteOgImageUrl } from "@/lib/og-image-urls";

/**
 * Standard metadata for a docs page: title + description plus a COMPLETE
 * openGraph block (`type` + canonical `url`) and a matching canonical alternate.
 *
 * Centralized so individual docs pages can't drift back into a bare
 * `{ title }` that ships no `og:url`/`og:type` — the gap Ahrefs flagged across
 * the docs surface in June 2026. A page that sets its own `openGraph` replaces
 * the root layout's wholesale (Next merges metadata shallowly), so `type` must
 * be repeated here rather than inherited.
 */
export function docPageMetadata(
  slug: string,
  { title, description, og }: Pick<DocFrontmatter, "title" | "description" | "og">,
): Metadata {
  const url = docPath(slug);
  // Pages with `og` frontmatter get their own card; the rest share the site card.
  const img = og
    ? ogImageFields(docOgImageUrl(slug), { alt: og.alt, ...OG_SIZE, type: OG_CONTENT_TYPE })
    : ogImageFields(siteOgImageUrl());
  return {
    title,
    description,
    openGraph: {
      type: "website",
      url,
      title,
      ...(description ? { description } : {}),
      ...img.openGraph,
    },
    twitter: {
      title,
      ...(description ? { description } : {}),
      ...img.twitter,
    },
    alternates: { canonical: url, types: { "text/markdown": docMdPath(slug) } },
  };
}
