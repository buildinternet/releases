/**
 * Which registry pages we ask search engines to index.
 *
 * Release text is the vendor's own, so a page that only lists it adds little
 * over the vendor's changelog. An org earns indexing when it has something of
 * ours on top: a generated overview, plus enough release history for the
 * timeline to be worth reading. Its product and source pages follow the org.
 *
 * Pages below the bar still render and stay linked (`noindex, follow`); they
 * just aren't submitted in the sitemap or offered for indexing.
 */
export const ORG_INDEX_MIN_RELEASES = 10;

export interface OrgIndexSignals {
  releaseCount?: number | null;
  hasOverview?: boolean | null;
}

export function orgMeetsIndexBar(org: OrgIndexSignals): boolean {
  return org.hasOverview === true && (org.releaseCount ?? 0) >= ORG_INDEX_MIN_RELEASES;
}

/**
 * Per-source copies of content that lives elsewhere: `/highlights` restates the
 * source feed, `/changelog` mirrors the repository's CHANGELOG file, and
 * `/{org}/sources` is a directory of links. Always `noindex, follow`.
 */
export const NOINDEX_FOLLOW = { index: false, follow: true } as const;
