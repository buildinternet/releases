"use client";

import { useState, useMemo } from "react";
import { type SourceActivity } from "@/lib/api";
import { DAY_MS, WEEK_MS, parseBuckets, fmtVersion } from "@/lib/cadence";
import { RangeNavigator } from "@/components/range-navigator";
import { ReleaseHeatmap, type HeatmapData } from "@/components/release-heatmap";
import { ViewModeToggle, type ViewMode } from "@/components/view-mode-toggle";

interface SourceTimelineProps {
  activity: SourceActivity;
  heatmap?: HeatmapData | null;
  trackingSince?: string | null;
}

export function SourceTimeline({ activity, heatmap, trackingSince }: SourceTimelineProps) {
  const [viewMode, setViewMode] = useState<ViewMode>(heatmap ? "heatmap" : "chart");

  const rangeStart = useMemo(() => new Date(activity.range.from), [activity.range.from]);
  const rangeEnd = useMemo(() => new Date(activity.range.to), [activity.range.to]);

  const rawBuckets = useMemo(() => parseBuckets(activity.weeklyBuckets), [activity.weeklyBuckets]);

  // Build a complete week grid from rangeStart to rangeEnd so empty weeks get 0-height bars
  const buckets = useMemo(() => {
    const bucketMap = new Map<number, (typeof rawBuckets)[number]>();
    for (const b of rawBuckets) {
      bucketMap.set(b.weekStart.getTime(), b);
    }
    const firstWeek = rawBuckets.length > 0 ? rawBuckets[0].weekStart.getTime() : rangeStart.getTime();
    const overshoot = firstWeek - rangeStart.getTime();
    const gridStart = overshoot <= 0 ? firstWeek : firstWeek - Math.ceil(overshoot / WEEK_MS) * WEEK_MS;
    const result: typeof rawBuckets = [];
    for (let ts = gridStart; ts < rangeEnd.getTime(); ts += WEEK_MS) {
      const existing = bucketMap.get(ts);
      result.push(existing ?? { weekStart: new Date(ts), count: 0 });
    }
    return result;
  }, [rawBuckets, rangeStart, rangeEnd]);

  // Default brush to last 3 months (or full range if data span < 91 days)
  const defaultBrushStart = useMemo(() => {
    const threeMonthsAgo = new Date(rangeEnd.getTime() - 91 * DAY_MS);
    return threeMonthsAgo > rangeStart ? threeMonthsAgo : rangeStart;
  }, [rangeStart, rangeEnd]);

  const [brushRange, setBrushRange] = useState<[Date, Date]>([defaultBrushStart, rangeEnd]);

  // Filter buckets to brushed window for stats
  const brushedBuckets = useMemo(() => {
    return buckets.filter((b) => {
      const bEnd = new Date(b.weekStart.getTime() + WEEK_MS);
      return bEnd > brushRange[0] && b.weekStart < brushRange[1];
    });
  }, [buckets, brushRange]);

  const summaryStats = useMemo(() => {
    const totalReleases = brushedBuckets.reduce((sum, b) => sum + b.count, 0);
    const weeks = brushedBuckets.length || 1;
    const avgPerWeek = totalReleases / weeks;
    const avgPerMonth = avgPerWeek * (30 / 7);

    let windowEarliestVersion: string | null = null;
    let windowLatestVersion: string | null = null;
    for (const b of brushedBuckets) {
      if (b.earliestVersion && !windowEarliestVersion) windowEarliestVersion = b.earliestVersion;
      if (b.latestVersion) windowLatestVersion = b.latestVersion;
    }

    const versionRange = windowEarliestVersion && windowLatestVersion && windowEarliestVersion !== windowLatestVersion
      ? { from: fmtVersion(windowEarliestVersion), to: fmtVersion(windowLatestVersion), rawFrom: windowEarliestVersion, rawTo: windowLatestVersion }
      : null;

    return { totalReleases, avgPerWeek, avgPerMonth, versionRange };
  }, [brushedBuckets]);

  if (buckets.length === 0) return null;

  return (
    <div className="mb-2">
      {heatmap && (
        <ViewModeToggle viewMode={viewMode} onViewModeChange={setViewMode} />
      )}

      {viewMode === "heatmap" && heatmap ? (
        <ReleaseHeatmap heatmap={heatmap} trackingSince={trackingSince} />
      ) : (
        <RangeNavigator.Root
          min={rangeStart}
          max={rangeEnd}
          buckets={buckets}
          value={brushRange}
          onValueChange={setBrushRange}
        >
          <RangeNavigator.Header />
          <RangeNavigator.DetailChart />
          <RangeNavigator.Overview />
          <RangeNavigator.QuickRanges defaultPreset="3 months" />
        </RangeNavigator.Root>
      )}

      <div className={`grid grid-cols-1 ${viewMode === "heatmap" ? "sm:grid-cols-2" : "sm:grid-cols-3"} gap-3 mb-4`}>
        {viewMode !== "heatmap" && (
          <div className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-1">Releases</div>
            <div className="text-xl font-bold text-stone-900 dark:text-stone-100 tabular-nums">{summaryStats.totalReleases}</div>
          </div>
        )}
        <div className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-1">Version Range</div>
          {summaryStats.versionRange ? (
            <div
              className="text-sm font-bold text-stone-900 dark:text-stone-100 tabular-nums"
              title={`${summaryStats.versionRange.rawFrom} → ${summaryStats.versionRange.rawTo}`}
            >
              <span className="block truncate">{summaryStats.versionRange.from}</span>
              <span className="text-stone-400 dark:text-stone-500 font-normal mx-0.5">{" → "}</span>
              <span className="block truncate">{summaryStats.versionRange.to}</span>
            </div>
          ) : (
            <div className="text-sm font-bold text-stone-900 dark:text-stone-100">{"\u2014"}</div>
          )}
        </div>
        <div className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-1">Avg Cadence</div>
          <div className="text-xl font-bold text-stone-900 dark:text-stone-100 tabular-nums">
            {summaryStats.avgPerMonth >= 1 ? `${Math.round(summaryStats.avgPerMonth)}/mo` : `${Math.round(summaryStats.avgPerWeek)}/wk`}
          </div>
        </div>
      </div>
    </div>
  );
}
