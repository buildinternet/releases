import { EXTERNAL_UGC_REL } from "./sanitize";

/** Minimal shape needed to pick a release row's default link target. */
export interface ReleaseLinkInput {
  id?: string | null;
  url?: string | null;
  /** Internal `/release/*` path (slugged), when the caller's data has it —
   *  preferred over the bare `/release/<id>` fallback so the internal link
   *  matches the canonical slugged URL. */
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
 * `/release/[id]/page.tsx`), so the default click goes straight to the
 * upstream `url` when the release has a referenceable one. The on-site
 * `/release/<id>` page stays reachable as a secondary affordance
 * (permalink / "Read more" / lightbox detail link) — it's just no longer
 * the default place a click lands. This also strips the main internal-link
 * paths crawlers used to discover tens of thousands of `/release/` URLs.
 *
 * Fallback order: upstream http(s) `url` → internal `/release/<id>` → null
 * (row renders an unlinked heading).
 */
export function releaseLinkTarget(release: ReleaseLinkInput): ReleaseLinkTarget | null {
  const url = (release.url ?? "").trim();
  if (/^https?:\/\//i.test(url)) return { href: url, external: true };
  const path = (release.path ?? "").trim();
  if (path.startsWith("/release/")) return { href: path, external: false };
  if (release.id) return { href: `/release/${release.id}`, external: false };
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
