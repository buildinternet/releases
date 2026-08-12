/** Minimal shape needed to pick a release row's default link target. */
export interface ReleaseLinkInput {
  id?: string | null;
  url?: string | null;
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
  if (release.id) return { href: `/release/${release.id}`, external: false };
  return null;
}
