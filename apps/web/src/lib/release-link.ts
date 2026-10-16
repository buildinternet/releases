import { EXTERNAL_UGC_REL } from "./sanitize";
import { isHttpUrl } from "@releases/rendering/digest-sections";

/** Minimal shape needed to pick a release row's default link target. */
export interface ReleaseLinkInput {
  id?: string | null;
  url?: string | null;
  /** Explicit internal `/release/*` path, when the caller already has the
   *  canonical slugged URL (digest citations). Not synthesized from `id`. */
  path?: string | null;
}

export interface ReleaseLinkTarget {
  href: string;
  /** True when `href` leaves the site (render target=_blank + UGC rel). */
  external: boolean;
}

/**
 * Default destination for a release row on feed surfaces.
 *
 * Release pages are noindexed stubs of upstream content (see
 * `/release/[id]/page.tsx`) and robots-disallowed, so a row links to the
 * upstream `url` when the release has a referenceable one. There is no
 * bare `/release/<id>` fallback: a row with no upstream URL renders
 * unlinked, so indexable pages don't hand crawlers a path onto those stubs.
 * An explicit slugged `path` is still honored when the caller already has
 * the canonical internal path (digest citations).
 *
 * Order: upstream http(s) `url` → slugged `/release/…` `path` when provided
 * → null (row renders an unlinked heading).
 */
export function releaseLinkTarget(release: ReleaseLinkInput): ReleaseLinkTarget | null {
  const url = (release.url ?? "").trim();
  if (isHttpUrl(url)) return { href: url, external: true };
  const path = (release.path ?? "").trim();
  if (path.startsWith("/release/")) return { href: path, external: false };
  return null;
}

/** Anchor props for a release link: {@link releaseLinkTarget}'s destination plus
 *  `data-release-id`, so an upstream link still records which registry release
 *  it stands for (analytics, scrapers, our own scripts). The data attribute is
 *  inert for navigation and SEO. */
export type ReleaseLinkProps = {
  href: string;
  target?: "_blank";
  rel?: string;
  "data-release-id"?: string;
};

export function releaseLinkProps(release: ReleaseLinkInput): ReleaseLinkProps | null {
  const link = releaseLinkTarget(release);
  if (!link) return null;
  return {
    href: link.href,
    ...(link.external ? { target: "_blank" as const, rel: EXTERNAL_UGC_REL } : {}),
    ...(release.id ? { "data-release-id": release.id } : {}),
  };
}

export const isExternalReleaseLink = (p: ReleaseLinkProps) => p.target === "_blank";
