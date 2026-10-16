/**
 * Which registry pages we ask search engines to index.
 *
 * Release text is the vendor's own, so a page that only lists it adds little
 * over the vendor's changelog. An org earns indexing when it has something of
 * ours on top: a generated overview, plus enough release history for the
 * timeline to be worth reading. Its product pages follow the org. Selected source
 * histories with dataset descriptions also follow it (source-dataset-pilot.ts).
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
 * A product page is indexable when its org clears the bar and the product has
 * enough releases of its own; a thin product's releases still show on the org
 * page. An unknown count (older API response) doesn't block indexing.
 */
export const PRODUCT_INDEX_MIN_RELEASES = 10;

export function productMeetsIndexBar(product: { releaseCount?: number | null }): boolean {
  return product.releaseCount == null || product.releaseCount >= PRODUCT_INDEX_MIN_RELEASES;
}

/**
 * Pages that feed the org and product views rather than standing on their own:
 * source pages outside the dataset pilot, their `/highlights` and `/changelog`
 * views, and the `/{org}/sources` directory. Always `noindex, follow`; they stay
 * reachable through links and the `.md` / `.json` / `.atom` formats.
 */
export const NOINDEX_FOLLOW = { index: false, follow: true } as const;
