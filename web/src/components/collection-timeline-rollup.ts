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
};

// GitHub releases are tag drops; everything else (RSS, scrape, agent, atom)
// is a marketing/content post and gets the hero treatment instead of the
// commit-log rollup. Kept here next to the rollup so the tag/post split and
// the grouping logic stay in lockstep.
export function isTag(r: { source: { type: string } }): boolean {
  return r.source.type === "github";
}

// App Store sources roll up too (#1236), but keyed per-source rather than by
// product — see the key branch in `rollupTags`. Distinct from `isTag`: appstore
// is not a GitHub tag and stays out of the collections post/tag split.
export function isAppStore(r: { source: { type: string } }): boolean {
  return r.source.type === "appstore";
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
    // App Store apps key per-source (#1236): a product can hold both an iOS and
    // a macOS source, and those are distinct platforms that must not merge into
    // one rollup. Every other source keys on product when bound, so a monorepo's
    // same-day package bumps unify under the product.
    const appStore = isAppStore(r);
    const groupSlug = appStore ? r.source.slug : (r.product?.slug ?? r.source.slug);
    const k = `${r.org?.slug ?? ""}::${groupSlug}`;
    let bucket = buckets.get(k);
    if (!bucket) {
      const label = appStore ? r.source.name : (r.product?.name ?? r.source.name);
      bucket = { label, releases: [] };
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
