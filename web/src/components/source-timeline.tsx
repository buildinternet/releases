"use client";

import { useState, useMemo, useCallback } from "react";
import { type SourceActivity } from "@/lib/api";
import { DAY_MS, WEEK_MS, parseBuckets, fmtVersion } from "@/lib/cadence";
import { RangeNavigator } from "@/components/range-navigator";
import { ReleaseHeatmap, type HeatmapData } from "@/components/release-heatmap";
import { ViewModeToggle, type ViewMode } from "@/components/view-mode-toggle";
import { VersionRangeDiff } from "@/components/version-range-diff";
import {
  RangePills,
  Stat,
  fmtCadence,
  highlightDaysForPreset,
  type RangePreset,
} from "@/components/timeline-chrome";

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
    const firstWeek =
      rawBuckets.length > 0 ? rawBuckets[0].weekStart.getTime() : rangeStart.getTime();
    const overshoot = firstWeek - rangeStart.getTime();
    const gridStart =
      overshoot <= 0 ? firstWeek : firstWeek - Math.ceil(overshoot / WEEK_MS) * WEEK_MS;
    const result: typeof rawBuckets = [];
    for (let ts = gridStart; ts < rangeEnd.getTime(); ts += WEEK_MS) {
      const existing = bucketMap.get(ts);
      result.push(existing ?? { weekStart: new Date(ts), count: 0 });
    }
    return result;
  }, [rawBuckets, rangeStart, rangeEnd]);

  const [rangePreset, setRangePreset] = useState<RangePreset>("90d");

  const presetStart = useCallback(
    (preset: RangePreset): Date => {
      if (preset === "all") return rangeStart;
      const days = preset === "90d" ? 90 : 30;
      const start = new Date(rangeEnd.getTime() - days * DAY_MS);
      return start > rangeStart ? start : rangeStart;
    },
    [rangeStart, rangeEnd],
  );

  const [brushRange, setBrushRange] = useState<[Date, Date]>(() => [presetStart("90d"), rangeEnd]);

  const setPreset = useCallback(
    (preset: RangePreset) => {
      setRangePreset(preset);
      setBrushRange([presetStart(preset), rangeEnd]);
    },
    [presetStart, rangeEnd],
  );

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

    let versionRange: {
      from: string;
      to: string;
      rawFrom: string;
      rawTo: string;
      collapsed: boolean;
    } | null = null;
    if (
      windowEarliestVersion &&
      windowLatestVersion &&
      windowEarliestVersion !== windowLatestVersion
    ) {
      const from = fmtVersion(windowEarliestVersion);
      const to = fmtVersion(windowLatestVersion);
      versionRange = {
        from,
        to,
        rawFrom: windowEarliestVersion,
        rawTo: windowLatestVersion,
        collapsed: from === to,
      };
    } else if (windowLatestVersion) {
      const v = fmtVersion(windowLatestVersion);
      versionRange = {
        from: v,
        to: v,
        rawFrom: windowLatestVersion,
        rawTo: windowLatestVersion,
        collapsed: true,
      };
    }

    return { totalReleases, avgPerWeek, avgPerMonth, versionRange };
  }, [brushedBuckets]);

  if (buckets.length === 0) return null;

  const cadenceLabel = fmtCadence(summaryStats.avgPerWeek, summaryStats.avgPerMonth);
  const heatmapHighlightDays = highlightDaysForPreset(rangePreset);
  const inHeatmapView = viewMode === "heatmap" && !!heatmap;

  const toolbar = (
    <div
      className={`flex items-center flex-wrap gap-2 ${heatmap ? "justify-between" : "justify-end"}`}
    >
      {heatmap && <ViewModeToggle viewMode={viewMode} onViewModeChange={setViewMode} />}
      <RangePills value={rangePreset} onChange={setPreset} />
    </div>
  );

  const statsRow = (
    <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[12px] text-stone-500 dark:text-stone-400">
      <Stat label="Releases" value={String(summaryStats.totalReleases)} />
      <Stat label="Avg" value={cadenceLabel} />
      {summaryStats.versionRange && (
        <Stat
          label="Versions"
          title={
            summaryStats.versionRange.collapsed
              ? summaryStats.versionRange.rawTo
              : `${summaryStats.versionRange.rawFrom} → ${summaryStats.versionRange.rawTo}`
          }
          value={
            <VersionRangeDiff
              from={summaryStats.versionRange.from}
              to={summaryStats.versionRange.to}
              collapsed={summaryStats.versionRange.collapsed}
            />
          }
        />
      )}
    </div>
  );

  if (inHeatmapView) {
    return (
      <div className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg px-5 py-4 mb-5">
        {toolbar}
        <div className="mt-4">
          <ReleaseHeatmap
            heatmap={heatmap!}
            trackingSince={trackingSince}
            highlightDays={heatmapHighlightDays}
            bare
          />
        </div>
        <div className="mt-3 pt-3 border-t border-stone-200 dark:border-stone-800">{statsRow}</div>
      </div>
    );
  }

  return (
    <div className="mb-2">
      {toolbar}
      <div className="mt-3">
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
      </div>
      <div className="mt-3 mb-5">{statsRow}</div>
    </div>
  );
}
