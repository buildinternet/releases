/**
 * Public URL builders for org / product / source pages in the web React
 * component tree.
 *
 * This module is the seam for the product-first namespace flip (#1190) on the
 * client: `productPath` now emits the bare `/${orgSlug}/${productSlug}` form
 * (the prefixed `/[org]/product/[slug]` route is a 308 alias), and every web
 * component that links to a product/source page routes through `productPath` /
 * `sourcePath` / `sourceIdPath`. Server-rendered markdown and XML
 * (`packages/rendering`) and worker-side URL builders construct product URLs
 * independently — they do not import these helpers and are updated alongside
 * this flip in a separate task.
 */

/**
 * Canonical product page URL. `orgSlug` is nullable to serve search catalog
 * hits, which may lack an org (rare); those fall back to the bare form.
 */
export function productPath(orgSlug: string | null, productSlug: string): string {
  return orgSlug ? `/${orgSlug}/${productSlug}` : `/product/${productSlug}`;
}

/** ID-keyed source page. The stable home for product-member / shadowed sources. */
export function sourceIdPath(sourceId: string): string {
  return `/sources/${sourceId}`;
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
