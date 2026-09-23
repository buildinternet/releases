import { etWeekStart, isDateKey } from "@buildinternet/releases-core/dates";

/**
 * First (newest) day key of each ET week → that week's Monday `weekStart`.
 * `dayKeys` must be newest-first (as `CollectionTimeline`'s day buckets are);
 * only the first day key seen for a given week is recorded, so the map has
 * exactly one entry per distinct ET week present in the input. Non-date keys
 * (e.g. the timeline's "unknown" bucket for releases with no `publishedAt`)
 * are skipped rather than throwing.
 */
export function weekBoundaries(dayKeys: string[]): Map<string, string> {
  const out = new Map<string, string>();
  let prevWeek: string | null = null;
  for (const key of dayKeys) {
    if (!isDateKey(key)) continue;
    const week = etWeekStart(key);
    if (week !== prevWeek) {
      out.set(key, week);
      prevWeek = week;
    }
  }
  return out;
}
