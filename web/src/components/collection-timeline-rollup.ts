import { type CollectionReleaseItem } from "@/lib/api";

/**
 * Minimal release shape the rollup needs. Both `CollectionReleaseItem` (cross-org
 * collection feed, carries an `org` block) and `OrgReleaseItem` (single-org feed,
 * no `org` block) satisfy it. `org` is optional precisely so the org feed can
 * reuse this: every row in that feed shares one org, so the bucket key's org
 * segment is a constant and can be dropped.
 */
export type RollupCandidate = {
  id?: string;
  url?: string | null;
  title: string;
  version?: string | null;
  source: { slug: string; name: string; type: string };
  product?: { slug: string; name: string } | null;
  org?: { slug: string; name: string };
  // Server-resolved grouping identity — COALESCE(product, source) (#1234).
  // Preferred when present; absent on older API responses, where we fall back
  // to deriving it from product ?? source below.
  groupSlug?: string;
  groupName?: string;
};

// GitHub releases are tag drops; everything else (RSS, scrape, agent, atom)
// is a marketing/content post and gets the hero treatment instead of the
// commit-log rollup. Kept here next to the rollup so the tag/post split and
// the grouping logic stay in lockstep.
export function isTag(r: { source: { type: string } }): boolean {
  return r.source.type === "github";
}

export type TagListItem<R = CollectionReleaseItem> =
  | { kind: "single"; release: R }
  | {
      kind: "rollup";
      /**
       * `org::(product|source)` — the bucket identity. Unique within a
       * day×org tag list, so it doubles as the row's React key. The org
       * segment is empty for the single-org feed (rows share one org).
       */
      groupKey: string;
      /** Display name: product name when bound, else the source name. */
      label: string;
      /** All releases in the bucket, newest-first (input order). */
      releases: R[];
    };

// Within a day's worth of GitHub tags for one org, collapse 2+ releases that
// share a group (product when bound, else source) into a single rollup. Lone
// tags stay as singles. The Map preserves first-appearance order, which is the
// feed's published-desc order, so the most recently active group leads and
// singles interleave naturally.
export function rollupTags<R extends RollupCandidate>(tags: R[]): TagListItem<R>[] {
  const buckets = new Map<string, { label: string; releases: R[] }>();

  for (const r of tags) {
    const groupSlug = r.groupSlug ?? r.product?.slug ?? r.source.slug;
    const k = `${r.org?.slug ?? ""}::${groupSlug}`;
    let bucket = buckets.get(k);
    if (!bucket) {
      bucket = { label: r.groupName ?? r.product?.name ?? r.source.name, releases: [] };
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
