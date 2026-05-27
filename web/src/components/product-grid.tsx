import Link from "next/link";
import type { OrgDetail } from "@/lib/api";
import { productPath } from "@/lib/links";

/**
 * Hub product cards on the org Overview page. Renders only when the org has
 * 2+ products — at ≤1 product the org page is already the single product's
 * feed (and the product page 301s home), so a grid would be redundant.
 */
export function ProductGrid({
  orgSlug,
  products,
}: {
  orgSlug: string;
  products: OrgDetail["products"];
}) {
  if (products.length < 2) return null;

  return (
    <div className="mt-5">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-3">
        Products
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {products.map((p) => (
          <Link
            key={p.slug}
            href={productPath(orgSlug, p.slug)}
            className="flex items-center justify-between rounded-lg border border-stone-200 dark:border-stone-800 hover:border-stone-300 dark:hover:border-stone-700 bg-white dark:bg-stone-900 px-3 py-2.5 transition-colors"
          >
            <span className="text-sm font-medium text-stone-800 dark:text-stone-200 truncate">
              {p.name}
            </span>
            <span className="text-xs text-stone-400 dark:text-stone-500 shrink-0 ml-3">
              {p.releaseCount} release{p.releaseCount === 1 ? "" : "s"}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
