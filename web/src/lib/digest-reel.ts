import type { HomepageDigestsQuery } from "@/lib/graphql/__generated__/graphql";

export type ReelDigest = HomepageDigestsQuery["latestWeeklyDigests"][number];
type ReelSection = ReelDigest["sections"][number];
type ReelOrg = ReelSection["releases"][number]["org"];

/** Order the homepage reel — featured collections first, then the busiest
 *  weeks, then by name — and split it into the cards the reel shows and the
 *  overflow listed under "Also this week". */
export function splitDigestReel(digests: ReelDigest[], cardCount = 6) {
  const sorted = [...digests].sort(
    (a, b) =>
      Number(b.collection.isFeatured) - Number(a.collection.isFeatured) ||
      b.releaseCount - a.releaseCount ||
      a.collection.name.localeCompare(b.collection.name),
  );
  return { cards: sorted.slice(0, cardCount), more: sorted.slice(cardCount) };
}

/** Distinct products a section covers (by product slug, falling back to the
 *  org for product-less releases), labelled with the product name when there
 *  is one. Each carries its org for the avatar. */
export function sectionProducts(section: ReelSection) {
  const out = new Map<string, { key: string; name: string; org: ReelOrg }>();
  for (const r of section.releases) {
    const key = r.product?.slug ?? `org:${r.org.slug}`;
    if (!out.has(key)) out.set(key, { key, name: r.product?.name ?? r.org.name, org: r.org });
  }
  return [...out.values()];
}

/** Internal link to a digest issue, optionally deep-linked to a section. */
export function digestHref(d: Pick<ReelDigest, "collection" | "weekStart">, anchor?: string) {
  return `/collections/${d.collection.slug}/digest/${d.weekStart}${anchor ? `#${anchor}` : ""}`;
}
