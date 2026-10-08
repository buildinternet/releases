import type { Metadata } from "next";
import { loadDoc } from "@/lib/docs";
import { ogImageFields, siteOgImageUrl } from "@/lib/og-image-urls";

/**
 * Docs slugs that ship their own co-located `opengraph-image.tsx`. They omit
 * `images` so Next merges that file in; every other docs page points at the
 * shared site card. Keep in sync with `apps/web/src/app/docs/**\/opengraph-image.tsx`.
 */
export const DOCS_WITH_OWN_OG_IMAGE: ReadonlySet<string> = new Set([
  "index",
  "why",
  "guides/find-a-changelog",
  "guides/changelog-rss-feed",
]);

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
  { title, description }: { title: string; description?: string },
): Metadata {
  const url = docPath(slug);
  // Conditional spread, never `images: undefined` (that suppresses the
  // co-located file convention too — see og-image-urls.ts).
  const img = DOCS_WITH_OWN_OG_IMAGE.has(slug) ? null : ogImageFields(siteOgImageUrl());
  return {
    title,
    description,
    openGraph: {
      type: "website",
      url,
      title,
      ...(description ? { description } : {}),
      ...img?.openGraph,
    },
    twitter: {
      title,
      ...(description ? { description } : {}),
      ...img?.twitter,
    },
    alternates: { canonical: url },
  };
}
