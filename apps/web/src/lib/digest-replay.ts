import type { DigestCoveredRelease } from "@/lib/api";
import { addDaysToDateKey, etDayKey } from "@buildinternet/releases-core/dates";
import {
  addInto,
  buildGlance,
  emptyProduct,
  GLANCE_TOP_N,
  releaseContribution,
  type GlanceOrg,
  type GlanceProduct,
  type GlanceRankedRelease,
} from "@/lib/digest-glance";

/**
 * Clock and frame math for the digest week replay: a finished weekly digest
 * played back day by day. Pure — the client stage only advances `t` and
 * renders whatever {@link frameAt} returns, so scrubbing is exact and a later
 * exporter can step through frames headlessly.
 *
 * `t` is week time in days: 0 is Monday 00:00 of the digest week, 7 is the end.
 * A release lands on its day and the day's releases are spaced evenly across
 * it in publish order (clock times only order releases within a day). Every
 * week plays in the same fixed length: {@link REPLAY_DAY_MS} per day at 1×.
 */

export const REPLAY_DAYS = 7;
/** Real milliseconds one replay day takes at 1× (7 days → 35s). */
export const REPLAY_DAY_MS = 5000;
/** Real ms (at 1×) a mark takes to fade in after it lands. */
export const MARK_FADE_MS = 600;
/** Real ms (at 1×) the arrival glow lasts on an importance 4–5 release. */
export const MARK_GLOW_MS = 2600;
/** "Biggest so far" rows during playback; the end state shows {@link GLANCE_TOP_N}. */
export const LIVE_TOP_N = 3;
/** Marks from one product on a busy day pack into at most this many rows. */
export const MAX_MARK_ROWS = 3;

/**
 * Nominal river track width used only for row packing. The real track is
 * fluid, so packing decides rows at this width and the marks then scale with
 * the column — close enough for "don't pile marks on top of each other".
 */
const PACK_TRACK_PX = 560;
const MARK_GAP_PX = 4;
/** Extra width a leading flame takes in front of an importance 4–5 mark. */
export const MARK_FLAME_PX = 14;

const DATE_ONLY_SUFFIX = "T00:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReplayDayInfo {
  /** Calendar day the release belongs to, `YYYY-MM-DD`. */
  dayKey: string;
  /** False for date-only stamps: the caption shows no time. */
  hasTime: boolean;
}

/**
 * Which day a stored `publishedAt` belongs to. No precision flag is stored
 * yet: a date-only source lands at exactly `T00:00:00.000Z`, so that exact
 * value is treated as date-only and keeps its UTC calendar date (its ET day
 * would be the previous evening). Anything else uses its ET day. Null when
 * there is no usable stamp.
 */
export function replayDay(publishedAt: string | null | undefined): ReplayDayInfo | null {
  if (!publishedAt) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(publishedAt)) return { dayKey: publishedAt, hasTime: false };
  if (Number.isNaN(Date.parse(publishedAt))) return null;
  if (publishedAt.endsWith(DATE_ONLY_SUFFIX)) {
    return { dayKey: publishedAt.slice(0, 10), hasTime: false };
  }
  return { dayKey: etDayKey(publishedAt), hasTime: true };
}

export interface ReplayItem {
  release: DigestCoveredRelease;
  /** Position in the input list — glance calls keep this order for stable ties. */
  index: number;
  /** Column, 0 (Monday) – 6 (Sunday), after clamping to the week. */
  day: number;
  /** Week time the release lands, in days. */
  at: number;
  /** The release's own day and whether it carried a clock time; null when unstamped. */
  stamp: ReplayDayInfo | null;
  /** Lane / tile this release belongs to (`others` when folded). */
  groupKey: string;
  productName: string;
  /** Impact over the whole week — sizes the mark and breaks caption ties. */
  finalImpact: number;
  /** Packed row within the lane, 0 – {@link MAX_MARK_ROWS}−1. */
  row: number;
  /** Mark band width in px at full size (flame excluded). */
  markWidth: number;
}

export interface ReplayLane {
  key: string;
  name: string;
  /** Null for the "Others" lane. */
  org: GlanceOrg | null;
  /** This lane's releases, by `at`. */
  items: ReplayItem[];
}

export interface Replay {
  weekStart: string;
  /** The week's seven `YYYY-MM-DD` keys, Monday first. */
  dayKeys: string[];
  /** Every release, by `at`. */
  items: ReplayItem[];
  /** One lane per final tile, in the final ranking. */
  lanes: ReplayLane[];
}

function dayIndexOf(dayKey: string, weekStart: string): number {
  return Math.round(
    (Date.parse(`${dayKey}T00:00:00Z`) - Date.parse(`${weekStart}T00:00:00Z`)) / DAY_MS,
  );
}

/** Sort stamp within a day: the clock time when known, else noon ET. */
function orderStamp(r: DigestCoveredRelease, stamp: ReplayDayInfo | null): number {
  if (!stamp) return Infinity;
  return stamp.hasTime ? Date.parse(r.publishedAt!) : Date.parse(`${stamp.dayKey}T16:00:00Z`);
}

/** Mark band width in px: wider for more impact. */
export function markWidth(finalImpact: number): number {
  return 10 + finalImpact * 9;
}

export function buildReplay(releases: readonly DigestCoveredRelease[], weekStart: string): Replay {
  const dayKeys = Array.from({ length: REPLAY_DAYS }, (_, d) => addDaysToDateKey(weekStart, d));
  const final = buildGlance(releases);
  const byRelease = new Map(final.ranked.map((r) => [r.release, r]));

  const placed = releases.map((release, index) => {
    const stamp = replayDay(release.publishedAt);
    // Outside the week (the digest windows on fetch time) clamps to the
    // nearest edge; no stamp lands on the last day.
    const raw = stamp ? dayIndexOf(stamp.dayKey, weekStart) : REPLAY_DAYS - 1;
    const day = Math.min(REPLAY_DAYS - 1, Math.max(0, raw));
    const ranked = byRelease.get(release)!;
    return {
      release,
      index,
      day,
      at: 0,
      stamp,
      groupKey: ranked.groupKey,
      productName: ranked.productName,
      finalImpact: ranked.impact,
      row: 0,
      markWidth: markWidth(ranked.impact),
      sortKey: orderStamp(release, stamp),
    };
  });

  const items: ReplayItem[] = [];
  for (let d = 0; d < REPLAY_DAYS; d++) {
    const today = placed
      .filter((p) => p.day === d)
      .sort(
        (a, b) =>
          a.sortKey - b.sortKey ||
          (b.release.importance ?? 0) - (a.release.importance ?? 0) ||
          a.index - b.index,
      );
    today.forEach((p, j) => {
      const { sortKey: _sortKey, ...item } = p;
      items.push({ ...item, at: d + (j + 0.5) / today.length });
    });
  }

  const lanes: ReplayLane[] = final.products.map((p) => ({
    key: p.key,
    name: p.name,
    org: p.org,
    items: items.filter((it) => it.groupKey === p.key),
  }));

  // Pack each lane's marks into rows: first row whose last mark ends clear of
  // this one, else the row that frees up soonest (marks overlap past the cap).
  for (const lane of lanes) {
    const ends: number[] = Array.from({ length: MAX_MARK_ROWS }, () => -Infinity);
    for (const it of lane.items) {
      const w = it.markWidth + ((it.release.importance ?? 0) >= 4 ? MARK_FLAME_PX : 0);
      const x = (it.at / REPLAY_DAYS) * PACK_TRACK_PX;
      let row = ends.findIndex((e) => e + MARK_GAP_PX <= x - w / 2);
      if (row < 0) row = ends.indexOf(Math.min(...ends));
      ends[row] = x + w / 2;
      it.row = row;
    }
  }

  return { weekStart, dayKeys, items, lanes };
}

export type ReplayKicker = "Landmark" | "Major release" | "Today" | "Latest";

export interface ReplayCaption {
  item: ReplayItem;
  kicker: ReplayKicker;
  /** Other releases from the same lane that day so far. */
  moreCount: number;
}

export interface ReplayFrame {
  t: number;
  ended: boolean;
  /** Current day column, 0–6. */
  dayIndex: number;
  /** Releases landed so far, by `at`. */
  shipped: ReplayItem[];
  /**
   * Running tile per lane, in the FINAL ranking (never re-sorted, so tiles
   * grow in place). Lanes with nothing shipped yet have impact 0.
   */
  products: GlanceProduct[];
  /** Top {@link LIVE_TOP_N} so far, {@link GLANCE_TOP_N} once ended. */
  top: GlanceRankedRelease[];
  /** Null before anything ships and once the week has ended. */
  caption: ReplayCaption | null;
}

const clampT = (t: number) => Math.min(REPLAY_DAYS, Math.max(0, t));

export function frameAt(replay: Replay, tIn: number): ReplayFrame {
  const t = clampT(tIn);
  const ended = t >= REPLAY_DAYS;
  const dayIndex = Math.min(REPLAY_DAYS - 1, Math.floor(t));
  const shipped = replay.items.filter((it) => it.at <= t);

  // Impact so far: buildGlance on the shipped subset in input order, so the
  // minor pool saturates per subset and the last frame IS buildGlance(all).
  const inInputOrder = [...shipped].sort((a, b) => a.index - b.index);
  const glance = buildGlance(inInputOrder.map((it) => it.release));
  const impactOf = new Map(glance.ranked.map((r) => [r.release, r.impact]));

  // Roll up into the final lanes rather than the subset's own grouping: a
  // product the subset folds into "Others" may hold its own lane by the end.
  const byKey = new Map(replay.lanes.map((l) => [l.key, emptyProduct(l.key, l.name, l.org)]));
  for (const it of inInputOrder) {
    addInto(byKey.get(it.groupKey)!, releaseContribution(it.release, impactOf.get(it.release)!));
  }
  const products = replay.lanes.map((l) => byKey.get(l.key)!);
  for (const p of products) p.flames.sort((a, b) => b - a);

  const top = glance.ranked.slice(0, ended ? GLANCE_TOP_N : LIVE_TOP_N);

  return {
    t,
    ended,
    dayIndex,
    shipped,
    products,
    top,
    caption: ended ? null : captionAt(shipped, dayIndex),
  };
}

/**
 * The current day's most important release so far. It changes only when a
 * bigger one lands, so busy days don't flicker; a quiet day keeps the last
 * day's caption.
 */
function captionAt(shipped: ReplayItem[], dayIndex: number): ReplayCaption | null {
  if (shipped.length === 0) return null;
  const today = shipped.some((it) => it.day === dayIndex);
  const capDay = today ? dayIndex : shipped[shipped.length - 1].day;
  const onDay = shipped.filter((it) => it.day === capDay);
  let lead = onDay[0];
  for (const it of onDay) {
    const di = (it.release.importance ?? 0) - (lead.release.importance ?? 0);
    if (di > 0 || (di === 0 && it.finalImpact > lead.finalImpact)) lead = it;
  }
  const importance = lead.release.importance ?? 0;
  const kicker: ReplayKicker =
    importance === 5 ? "Landmark" : importance === 4 ? "Major release" : today ? "Today" : "Latest";
  const moreCount = onDay.filter((it) => it.groupKey === lead.groupKey).length - 1;
  return { item: lead, kicker, moreCount };
}

/**
 * Week time → real ms elapsed at 1× since `at`. Fades and glows derive from
 * this (never from wall-clock arrival), so any `t` renders the same frame.
 */
export function arrivalAgeMs(t: number, at: number): number {
  return (t - at) * REPLAY_DAY_MS;
}

/** Reduced-motion stepping: each stop is the end of a day. */
export function nextDayStop(t: number): number {
  return Math.min(REPLAY_DAYS, Math.floor(t + 1e-9) + 1);
}

export function prevDayStop(t: number): number {
  return Math.max(0, Math.ceil(t - 1e-9) - 1);
}
