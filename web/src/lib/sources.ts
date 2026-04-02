import type { SourceListItem } from "@/lib/api";

interface ProductRef {
  slug: string;
  name: string;
  url?: string | null;
  description?: string | null;
  sourceCount?: number;
}

/**
 * Groups sources by their productSlug, returning an ordered list of products
 * (filtered to only those with sources) and any ungrouped sources.
 */
export function groupSourcesByProduct<P extends ProductRef>(
  sources: SourceListItem[],
  products: P[],
): { grouped: Array<{ product: P; sources: SourceListItem[] }>; ungrouped: SourceListItem[] } {
  const byProduct = new Map<string | null, SourceListItem[]>();
  for (const source of sources) {
    const key = source.productSlug ?? null;
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key)!.push(source);
  }

  const grouped = products
    .filter((p) => byProduct.has(p.slug))
    .map((product) => ({ product, sources: byProduct.get(product.slug)! }));

  return { grouped, ungrouped: byProduct.get(null) ?? [] };
}
