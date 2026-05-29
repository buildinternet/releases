import type { OrgReleaseItem } from "@/lib/api";
import { isAppStore, isTag, rollupTags, type TagListItem } from "./collection-timeline-rollup";

// Sources whose same-day clusters fold into a rollup row: GitHub tags (keyed
// product ?? source) and App Store apps (keyed per-source, #1236). Posts
// (feed/scrape/agent) never roll up — they keep the hero/flat-row treatment.
const isRollupEligible = (r: OrgReleaseItem) => isTag(r) || isAppStore(r);

export type RollupItem = Extract<TagListItem<OrgReleaseItem>, { kind: "rollup" }>;

// One rendered row in the date-rail feed. A `row` is a normal `ReleaseListItem`
// (a post, or a lone GitHub tag); a `rollup` is a collapsed cluster of 2+ tags
// that share a product/source within the same day (#1233).
export type FeedEntry =
  | { kind: "row"; release: OrgReleaseItem }
  | { kind: "rollup"; item: RollupItem };

const releaseDayKey = (iso: string | null) => (iso ? iso.slice(0, 10) : "undated");

/** UTC-day a feed entry belongs to — drives the `hideDate` rail logic. A rollup
 *  carries the day of its newest member (rollupTags keeps input order). */
export function entryDayKey(entry: FeedEntry): string {
  return entry.kind === "row"
    ? releaseDayKey(entry.release.publishedAt)
    : releaseDayKey(entry.item.releases[0].publishedAt);
}

// Collapse same-day GitHub-tag and App Store clusters into rollups while leaving
// posts and lone tags as flat rows. The feed arrives published-desc, so same-day
// rows are contiguous — we slice each day and bucket its eligible rows via the
// shared `rollupTags`. A 2+ bucket renders once, at its newest member's position;
// everything else (posts, single tags) stays in place. This keeps the
// published-desc interleave while folding away monorepo package-bump and
// same-day app-version noise (#1233, #1236).
export function buildFeedEntries(releases: OrgReleaseItem[]): FeedEntry[] {
  const entries: FeedEntry[] = [];
  let i = 0;
  while (i < releases.length) {
    const day = releaseDayKey(releases[i].publishedAt);
    let j = i;
    while (j < releases.length && releaseDayKey(releases[j].publishedAt) === day) j++;
    appendDayEntries(entries, releases.slice(i, j));
    i = j;
  }
  return entries;
}

function appendDayEntries(out: FeedEntry[], dayReleases: OrgReleaseItem[]) {
  // `rollupTags` keeps the same release object references it's handed, so a
  // reference-keyed Map cleanly maps each clustered tag back to its rollup.
  const rollupByMember = new Map<OrgReleaseItem, RollupItem>();
  for (const item of rollupTags(dayReleases.filter(isRollupEligible))) {
    if (item.kind === "rollup") {
      for (const r of item.releases) rollupByMember.set(r, item);
    }
  }
  const emitted = new Set<string>();
  for (const r of dayReleases) {
    const rollup = rollupByMember.get(r);
    if (rollup) {
      if (!emitted.has(rollup.groupKey)) {
        emitted.add(rollup.groupKey);
        out.push({ kind: "rollup", item: rollup });
      }
      continue;
    }
    out.push({ kind: "row", release: r });
  }
}
