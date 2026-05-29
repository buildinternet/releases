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
      /**
       * `org::(product|source)` — the bucket identity. Unique within a
       * day×org tag list, so it doubles as the row's React key.
       */
      groupKey: string;
      /** Display name: product name when bound, else the source name. */
      label: string;
      /** All releases in the bucket, newest-first (input order). */
      releases: CollectionReleaseItem[];
    };

// Within a day's worth of GitHub tags for one org, collapse 2+ releases that
// share a group (product when bound, else source) into a single rollup. Lone
// tags stay as singles. The Map preserves first-appearance order, which is the
// feed's published-desc order, so the most recently active group leads and
// singles interleave naturally.
export function rollupTags(tags: CollectionReleaseItem[]): TagListItem[] {
  const buckets = new Map<string, { label: string; releases: CollectionReleaseItem[] }>();

  for (const r of tags) {
    const groupSlug = r.product?.slug ?? r.source.slug;
    const k = `${r.org.slug}::${groupSlug}`;
    let bucket = buckets.get(k);
    if (!bucket) {
      bucket = { label: r.product?.name ?? r.source.name, releases: [] };
      buckets.set(k, bucket);
    }
    bucket.releases.push(r);
  }

  return [...buckets].map(([groupKey, b]) =>
    b.releases.length < 2
      ? { kind: "single", release: b.releases[0] }
      : { kind: "rollup", groupKey, label: b.label, releases: b.releases },
  );
}
