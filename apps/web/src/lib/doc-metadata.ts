import type { Metadata } from "next";
import { loadDoc } from "@/lib/docs";

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
  const { frontmatter } = loadDoc(slug);
  const url = docPath(slug);
  const { title, description } = frontmatter;
  return {
    title,
    description,
    openGraph: {
      type: "website",
      url,
      title,
      ...(description ? { description } : {}),
    },
    twitter: {
      title,
      ...(description ? { description } : {}),
    },
    alternates: { canonical: url },
  };
}
