"use client";

import { useState, useMemo } from "react";
import { type SourceActivity } from "@/lib/api";
import { DAY_MS, WEEK_MS, parseBuckets, fmtVersion } from "@/lib/cadence";
import { RangeNavigator } from "@/components/range-navigator";

interface SourceTimelineProps {
  activity: SourceActivity;
}

export function SourceTimeline({ activity }: SourceTimelineProps) {
  const rangeStart = useMemo(() => new Date(activity.range.from), [activity.range.from]);
  const rangeEnd = useMemo(() => new Date(activity.range.to), [activity.range.to]);

  const buckets = useMemo(() => parseBuckets(activity.weeklyBuckets), [activity.weeklyBuckets]);

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
    <div className="mb-6">
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

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <div className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-1">Releases</div>
          <div className="text-xl font-bold text-stone-900 dark:text-stone-100 tabular-nums">{summaryStats.totalReleases}</div>
        </div>
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
