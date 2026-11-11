import type { Metadata } from "next";
import { loadDoc, type DocFrontmatter } from "@/lib/docs";
import { docOgImageUrl, ogImageFields, siteOgImageUrl } from "@/lib/og-image-urls";

/** Canonical path for a docs slug. The "index" doc owns `/docs` itself. */
export function docPath(slug: string): string {
  return slug === "index" ? "/docs" : `/docs/${slug}`;
}

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
export function docPageMetadata(slug: string): Metadata {
  return buildDocPageMetadata(slug, loadDoc(slug).frontmatter);
}

/** Pure half of {@link docPageMetadata} (no filesystem read) so it is unit-testable. */
export function buildDocPageMetadata(
  slug: string,
  { title, description, og }: Pick<DocFrontmatter, "title" | "description" | "og">,
): Metadata {
  const url = docPath(slug);
  // Pages with `og` frontmatter get their own card; the rest share the site card.
  const img = og
    ? // Same size/type as `OG_SIZE`/`OG_CONTENT_TYPE` in `@/lib/og` (not imported: it pulls in fonts).
      ogImageFields(docOgImageUrl(slug), {
        alt: og.alt,
        width: 1200,
        height: 630,
        type: "image/png",
      })
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
    alternates: { canonical: url, types: { "text/markdown": `${url}.md` } },
  };
}
