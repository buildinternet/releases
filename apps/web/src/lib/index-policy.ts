/**
 * Which registry pages we ask search engines to index.
 *
 * Release text is the vendor's own, so a page that only lists it adds little
 * over the vendor's changelog. An org earns indexing when it has something of
 * ours on top: a generated overview, plus enough release history for the
 * timeline to be worth reading. Its product pages follow the org; source
 * pages are never indexed (see `NOINDEX_FOLLOW`).
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
 * Pages that feed the org and product views rather than standing on their own:
 * source pages (one input feed each), their `/highlights` and `/changelog`
 * views, and the `/{org}/sources` directory. Always `noindex, follow`; they stay
 * reachable through links and the `.md` / `.json` / `.atom` formats.
 */
export const NOINDEX_FOLLOW = { index: false, follow: true } as const;
