import type { DigestCoveredRelease } from "@/lib/api";
import { addDaysToDateKey, etDayKey } from "@buildinternet/releases-core/dates";
import { DAY_MS } from "@/lib/cadence";
import {
  buildGlance,
  GLANCE_TOP_N,
  rollUpProducts,
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
const MARK_FLAME_PX = 14;

const DATE_ONLY_SUFFIX = "T00:00:00.000Z";

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
  /** Mark width in px including its leading flame, if any. */
  extent: number;
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
  /** Tiles and rankings after the first k landings, k = 0…items.length. */
  states: ReplayState[];
}

/**
 * Everything that changes only when a release lands, computed once per
 * landing so a 60fps clock re-renders from stable objects.
 */
export interface ReplayState {
  /** Running tile per lane, in the FINAL ranking (never re-sorted, so tiles grow in place). */
  products: GlanceProduct[];
  /** Top {@link LIVE_TOP_N} so far. */
  liveTop: GlanceRankedRelease[];
  /** Top {@link GLANCE_TOP_N} so far — the end state's list. */
  top: GlanceRankedRelease[];
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
function markWidth(finalImpact: number): number {
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
    return {
      release,
      index,
      stamp,
      day: Math.min(REPLAY_DAYS - 1, Math.max(0, raw)),
      order: orderStamp(release, stamp),
    };
  });

  const items: ReplayItem[] = [];
  for (let d = 0; d < REPLAY_DAYS; d++) {
    const today = placed
      .filter((p) => p.day === d)
      .sort(
        (a, b) =>
          a.order - b.order ||
          (b.release.importance ?? 0) - (a.release.importance ?? 0) ||
          a.index - b.index,
      );
    today.forEach(({ release, index, stamp, day }, j) => {
      const ranked = byRelease.get(release)!;
      const width = markWidth(ranked.impact);
      items.push({
        release,
        index,
        day,
        at: d + (j + 0.5) / today.length,
        stamp,
        groupKey: ranked.groupKey,
        productName: ranked.productName,
        finalImpact: ranked.impact,
        row: 0,
        markWidth: width,
        extent: width + ((release.importance ?? 0) >= 4 ? MARK_FLAME_PX : 0),
      });
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
      const x = (it.at / REPLAY_DAYS) * PACK_TRACK_PX;
      let row = ends.findIndex((e) => e + MARK_GAP_PX <= x - it.extent / 2);
      if (row < 0) row = ends.indexOf(Math.min(...ends));
      ends[row] = x + it.extent / 2;
      it.row = row;
    }
  }

  const states = Array.from({ length: items.length + 1 }, (_, k) => stateAfter(items, lanes, k));
  return { weekStart, dayKeys, items, lanes, states };
}

/**
 * Impact after the first `k` landings: buildGlance on that subset in input
 * order, so the minor pool saturates per subset and the last state IS
 * buildGlance(all). Rolled up into the final lanes rather than the subset's
 * own grouping — a product the subset folds into "Others" may hold its own
 * lane by the end.
 */
function stateAfter(items: ReplayItem[], lanes: ReplayLane[], k: number): ReplayState {
  const shipped = items.slice(0, k).sort((a, b) => a.index - b.index);
  const glance = buildGlance(shipped.map((it) => it.release));
  const impactOf = new Map(glance.ranked.map((r) => [r.release, r.impact]));
  const products = rollUpProducts(
    lanes,
    shipped.map((it) => ({
      release: it.release,
      impact: impactOf.get(it.release)!,
      groupKey: it.groupKey,
    })),
  );
  return {
    products,
    liveTop: glance.ranked.slice(0, LIVE_TOP_N),
    top: glance.ranked.slice(0, GLANCE_TOP_N),
  };
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
  /** Running tiles in the final ranking (see {@link ReplayState}). */
  products: GlanceProduct[];
  /** Top {@link LIVE_TOP_N} so far, {@link GLANCE_TOP_N} once ended. */
  top: GlanceRankedRelease[];
  /** Null before anything ships and once the week has ended. */
  caption: ReplayCaption | null;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function frameAt(replay: Replay, tIn: number): ReplayFrame {
  const t = Math.min(REPLAY_DAYS, Math.max(0, tIn));
  const ended = t >= REPLAY_DAYS;
  const dayIndex = Math.min(REPLAY_DAYS - 1, Math.floor(t));
  let count = 0;
  while (count < replay.items.length && replay.items[count].at <= t) count++;
  const shipped = replay.items.slice(0, count);
  const state = replay.states[count];
  return {
    t,
    ended,
    dayIndex,
    shipped,
    products: state.products,
    top: ended ? state.top : state.liveTop,
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
 * How far a landed mark has faded in (0–1) and how much arrival glow is left
 * (1–0), from week time alone — never wall-clock arrival — so any `t` renders
 * the same frame. Real time is measured at 1×.
 */
export function arrivalFade(t: number, at: number): number {
  return clamp01(((t - at) * REPLAY_DAY_MS) / MARK_FADE_MS);
}

export function arrivalGlow(t: number, at: number): number {
  return 1 - clamp01(((t - at) * REPLAY_DAY_MS) / MARK_GLOW_MS);
}

/** Reduced-motion stepping: each stop is the end of a day. */
export function nextDayStop(t: number): number {
  return Math.min(REPLAY_DAYS, Math.floor(t + 1e-9) + 1);
}

export function prevDayStop(t: number): number {
  return Math.max(0, Math.ceil(t - 1e-9) - 1);
}
