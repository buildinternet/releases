/**
 * Build a `/catalog` URL preserving the two independent filters — the optional
 * `category` slug and the `?empty=1` toggle. Shared by the category chips and
 * the empty-orgs toggle so each link keeps the other's state. Order is fixed
 * (category, then empty) for stable, testable output.
 */
export function catalogHref(opts: { category?: string | null; includeEmpty?: boolean }): string {
  const params = new URLSearchParams();
  if (opts.category) params.set("category", opts.category);
  if (opts.includeEmpty) params.set("empty", "1");
  const qs = params.toString();
  return qs ? `/catalog?${qs}` : "/catalog";
}
