import type { ReleaseComposition } from "@buildinternet/releases-core/composition";
import { normalizeVersionLabel } from "@/lib/release-title";
import type { FeedEntry, RollupItem } from "@/components/org-release-entries";

/**
 * Pure derivation logic for the `/updates` redesign — month/area grouping,
 * composition summing, and the fix-only-day detection that decides between the
 * full entry layout and the compact one-liner row. Split from `updates-feed.tsx`
 * so it's unit-testable without a DOM harness, `bun:test`-style like
 * `org-release-entries.test.ts`.
 */

// ── Month grouping (Timeline rail) ──

/** UTC month bucket key ("2026-07") for a release's `publishedAt`, or "undated". */
export function monthKeyOf(iso: string | null | undefined): string {
  if (!iso) return "undated";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "undated";
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Human month label ("July 2026") for a `monthKeyOf` key. */
export function monthLabelOf(key: string): string {
  if (key === "undated") return "Undated";
  const [year, month] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export interface MonthBucket {
  key: string;
  label: string;
  count: number;
}

/**
 * One row per month present in `releases`, newest-first, with a count. Any
 * "undated" bucket sorts last regardless of position. Callers pre-filter
 * `releases` by area (or not) depending on whether the Timeline should react
 * to the Area filter — see `updates-feed.tsx`'s choice, documented there.
 */
export function buildMonthBuckets(
  releases: readonly { publishedAt: string | null }[],
): MonthBucket[] {
  const counts = new Map<string, number>();
  for (const r of releases) {
    const key = monthKeyOf(r.publishedAt);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => {
      if (a === "undated") return 1;
      if (b === "undated") return -1;
      return a < b ? 1 : a > b ? -1 : 0;
    })
    .map(([key, count]) => ({ key, label: monthLabelOf(key), count }));
}

// ── Area grouping (Area rail) ──

/** Display-label overrides for known group slugs. Anything not listed here
 *  falls back to the release's own group label, so a future group (e.g. an
 *  `api`/`mcp` product) shows up automatically without a code change. */
export const AREA_LABEL_OVERRIDES: Record<string, string> = {
  "product-changelog": "Web",
  cli: "CLI",
};

export interface AreaGroup {
  slug: string;
  label: string;
}

/** Server-resolved grouping identity for a release — mirrors the
 *  `groupSlug ?? product?.slug ?? source.slug` fallback used by the rollup
 *  logic (`collection-timeline-rollup.ts`), so Area filtering agrees with
 *  same-day rollup bucketing. */
export function areaGroupOf(r: {
  groupSlug?: string;
  groupName?: string;
  product?: { slug: string; name: string } | null;
  source: { slug: string; name: string };
}): AreaGroup {
  const slug = r.groupSlug ?? r.product?.slug ?? r.source.slug;
  const rawLabel = r.groupName ?? r.product?.name ?? r.source.name;
  return { slug, label: AREA_LABEL_OVERRIDES[slug] ?? rawLabel };
}

/** One entry per distinct area present in `releases`, in first-appearance
 *  order (the feed arrives published-desc, so this reads most-recently-active
 *  area first — matches the mockup's Web/CLI ordering without a fixed list). */
export function buildAreaBuckets(
  releases: readonly {
    groupSlug?: string;
    groupName?: string;
    product?: { slug: string; name: string } | null;
    source: { slug: string; name: string };
  }[],
): AreaGroup[] {
  const seen = new Map<string, AreaGroup>();
  for (const r of releases) {
    const group = areaGroupOf(r);
    if (!seen.has(group.slug)) seen.set(group.slug, group);
  }
  return [...seen.values()];
}

// ── Composition (glyph counts) ──

/** Sum composition counts across a set of releases (a rollup's members).
 *  Missing/null composition on a member contributes zero. Returns `null` only
 *  when every count sums to zero (nothing to show). */
export function sumComposition(
  releases: readonly { composition?: ReleaseComposition | null }[],
): ReleaseComposition | null {
  let bugs = 0;
  let features = 0;
  let enhancements = 0;
  for (const r of releases) {
    if (!r.composition) continue;
    bugs += r.composition.bugs;
    features += r.composition.features;
    enhancements += r.composition.enhancements;
  }
  if (bugs === 0 && features === 0 && enhancements === 0) return null;
  return { bugs, features, enhancements };
}

/** A "fix-only" day/entry: only bug fixes, no new features or enhancements —
 *  renders as the compact one-liner row instead of the full entry. */
export function isFixOnlyComposition(c: ReleaseComposition | null | undefined): boolean {
  if (!c) return false;
  return c.bugs > 0 && c.features === 0 && c.enhancements === 0;
}

// ── Version range (rollup meta line) ──

/**
 * Version label for a feed entry's meta line. A single release gets its own
 * normalized version; a same-day rollup (2+ releases, newest-first per
 * `rollupTags`) gets the oldest→newest range ("v0.65.0→v0.66.0"). Returns
 * `null` when there's no version to show at all.
 */
export function versionRangeLabel(releases: readonly { version: string | null }[]): string | null {
  if (releases.length === 0) return null;
  if (releases.length === 1) return normalizeVersionLabel(releases[0].version);
  const newest = normalizeVersionLabel(releases[0].version);
  const oldest = normalizeVersionLabel(releases[releases.length - 1].version);
  if (!oldest && !newest) return null;
  if (!oldest) return newest;
  if (!newest) return oldest;
  if (oldest === newest) return newest;
  return `${oldest}→${newest}`;
}

// ── Per-entry derivation (row | rollup, from org-release-entries.ts) ──

/** Newest `publishedAt` for a feed entry (a rollup carries its newest
 *  member's date, matching `entryDayKey`). */
export function entryPublishedAt(entry: FeedEntry): string | null {
  return entry.kind === "row" ? entry.release.publishedAt : entry.item.releases[0].publishedAt;
}

/** Composition for a feed entry: the release's own for a row, summed across
 *  members for a rollup. */
export function entryComposition(entry: FeedEntry): ReleaseComposition | null {
  return entry.kind === "row"
    ? (entry.release.composition ?? null)
    : sumComposition(entry.item.releases);
}

/** Area group for a feed entry (a rollup's members share one group by
 *  construction — see `rollupGroup` in `collection-timeline-rollup.ts`). */
export function entryAreaGroup(entry: FeedEntry): AreaGroup {
  return entry.kind === "row" ? areaGroupOf(entry.release) : areaGroupOf(entry.item.releases[0]);
}

/** Version label for a feed entry's meta line. */
export function entryVersionLabel(entry: FeedEntry): string | null {
  return entry.kind === "row"
    ? normalizeVersionLabel(entry.release.version)
    : versionRangeLabel(entry.item.releases);
}

/** True when a rollup's members are all the same source/product's tags
 *  (always true today via `rollupTags`) — re-exported so callers can narrow
 *  without importing `RollupItem` directly. */
export type { RollupItem };
