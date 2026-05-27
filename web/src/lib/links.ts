/**
 * Public URL builders for org / product / source pages.
 *
 * This module is the single seam for the planned namespace flip (product-first
 * resolution on the bare `/[org]/[slug]` path — see the Phase 2 design doc's
 * "Long-term" section). When that lands, `productPath` changes to emit
 * `/${orgSlug}/${productSlug}` and a 308 is added from the prefixed form;
 * nothing else in the web tree needs to move.
 */

/**
 * Canonical product page URL. `orgSlug` is nullable to serve search catalog
 * hits, which may lack an org (rare); those fall back to the bare form.
 */
export function productPath(orgSlug: string | null, productSlug: string): string {
  return orgSlug ? `/${orgSlug}/product/${productSlug}` : `/product/${productSlug}`;
}

/**
 * Source detail page URL. Falls back to the global `/source/:slug` redirect
 * shim when the org isn't known.
 */
export function sourcePath(orgSlug: string | null, sourceSlug: string): string {
  return orgSlug ? `/${orgSlug}/${sourceSlug}` : `/source/${sourceSlug}`;
}

/**
 * Where a source row should link: the product page when the source belongs to
 * a product, otherwise the source page.
 */
export function sourceOrProductPath(args: {
  orgSlug: string | null;
  sourceSlug: string;
  productSlug?: string | null;
}): string {
  return args.productSlug
    ? productPath(args.orgSlug, args.productSlug)
    : sourcePath(args.orgSlug, args.sourceSlug);
}
