import { type CollectionReleaseItem } from "@/lib/api";

// GitHub releases are tag drops; everything else (RSS, scrape, agent, atom)
// is a marketing/content post and gets the hero treatment instead of the
// commit-log rollup. Kept here next to the rollup so the tag/post split and
// the grouping logic stay in lockstep.
export function isTag(r: CollectionReleaseItem): boolean {
  return r.source.type === "github";
}

export type TagListItem =
  | { kind: "single"; release: CollectionReleaseItem }
  | {
      kind: "rollup";
      /** `org::(product|source)` — stable identity for the bucket. */
      groupKey: string;
      /** Display name: product name when bound, else the source name. */
      label: string;
      orgSlug: string;
      /** All releases in the bucket, newest-first (input order). */
      releases: CollectionReleaseItem[];
      rollupId: string;
    };

// Within a day's worth of GitHub tags for one org, collapse 2+ releases that
// share a group (product when bound, else source) into a single rollup. Lone
// tags stay as singles. Buckets preserve first-appearance order, which is the
// feed's published-desc order, so the most recently active group leads and
// singles interleave naturally.
export function rollupTags(tags: CollectionReleaseItem[], scopeKey: string): TagListItem[] {
  const buckets = new Map<
    string,
    { label: string; orgSlug: string; releases: CollectionReleaseItem[] }
  >();
  const order: string[] = [];

  for (const r of tags) {
    const groupSlug = r.product?.slug ?? r.source.slug;
    const k = `${r.org.slug}::${groupSlug}`;
    let bucket = buckets.get(k);
    if (!bucket) {
      bucket = { label: r.product?.name ?? r.source.name, orgSlug: r.org.slug, releases: [] };
      buckets.set(k, bucket);
      order.push(k);
    }
    bucket.releases.push(r);
  }

  return order.map((k) => {
    const b = buckets.get(k)!;
    if (b.releases.length < 2) return { kind: "single", release: b.releases[0] };
    return {
      kind: "rollup",
      groupKey: k,
      label: b.label,
      orgSlug: b.orgSlug,
      releases: b.releases,
      rollupId: `rollup:${scopeKey}:${k}`,
    };
  });
}
