"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { type OrgActivity } from "@/lib/api";
import { type WeeklyBucket, WEEK_MS, DAY_MS } from "@/lib/cadence";
import { CadenceCard } from "@/components/cadence-card";
import { CadenceGrid } from "@/components/cadence-grid";
import { RangeNavigator, type SourceBucketEntry } from "@/components/range-navigator";

function parseBuckets(raw: Array<{ weekStart: string; count: number }>): WeeklyBucket[] {
  return raw.map((b) => ({ weekStart: new Date(b.weekStart), count: b.count }));
}

interface ReleaseTimelineProps {
  activity: OrgActivity;
  availableYears: number[];
  currentYear?: number;
  orgSlug: string;
}

export function ReleaseTimeline({ activity, availableYears, currentYear, orgSlug }: ReleaseTimelineProps) {
  const rangeStart = useMemo(() => new Date(activity.range.from), [activity.range.from]);
  const rangeEnd = useMemo(() => new Date(activity.range.to), [activity.range.to]);

  const aggregateBuckets = useMemo(() => parseBuckets(activity.aggregateWeekly), [activity.aggregateWeekly]);

  // Default brush to last 3 months (or full range if data span < 91 days)
  const defaultBrushStart = useMemo(() => {
    const threeMonthsAgo = new Date(rangeEnd.getTime() - 91 * DAY_MS);
    return threeMonthsAgo > rangeStart ? threeMonthsAgo : rangeStart;
  }, [rangeStart, rangeEnd]);

  const [brushRange, setBrushRange] = useState<[Date, Date]>([defaultBrushStart, rangeEnd]);

  // Parse buckets once — stable across brush changes
  const parsedSources = useMemo(() => {
    return activity.sources
      .filter((source) => source.releaseCount > 0)
      .map((source, i) => ({
        ...source,
        allBuckets: parseBuckets(source.weeklyBuckets),
        colorIndex: i,
      }));
  }, [activity.sources]);

  // Per-source bucket data for stacked bar chart (only meaningful with multiple sources)
  const sourceBuckets = useMemo<SourceBucketEntry[] | null>(() => {
    if (parsedSources.length <= 1) return null;
    return parsedSources.map((src) => ({
      name: src.name,
      slug: src.slug,
      colorIndex: src.colorIndex,
      buckets: src.allBuckets,
    }));
  }, [parsedSources]);

  // Use aggregate buckets as the canonical week grid (properly aligned by the API)
  const brushedWeekGrid = useMemo(() => {
    return aggregateBuckets.filter((b) => {
      const bEnd = new Date(b.weekStart.getTime() + WEEK_MS);
      return bEnd > brushRange[0] && b.weekStart < brushRange[1];
    });
  }, [aggregateBuckets, brushRange]);

  // Brush-sensitive — maps each source onto the canonical week grid
  const cardData = useMemo(() => {
    return parsedSources
      .map((source) => {
        // Build lookup from source's actual buckets (keyed by week-start timestamp)
        const bucketMap = new Map<number, number>();
        for (const b of source.allBuckets) {
          bucketMap.set(b.weekStart.getTime(), b.count);
        }

        // Map onto the canonical grid so all cards have the same number of bars
        const completeBuckets: WeeklyBucket[] = brushedWeekGrid.map((week) => ({
          weekStart: week.weekStart,
          count: bucketMap.get(week.weekStart.getTime()) ?? 0,
        }));

        const brushedCount = completeBuckets.reduce((sum, b) => sum + b.count, 0);

        return {
          name: source.name,
          slug: source.slug,
          releaseCount: brushedCount,
          totalReleaseCount: source.releaseCount,
          avgReleasesPerWeek: source.avgReleasesPerWeek,
          earliestVersion: source.earliestVersion,
          latestVersion: source.latestVersion,
          weeklyBuckets: completeBuckets,
          colorIndex: source.colorIndex,
        };
      })
      .sort((a, b) => b.releaseCount - a.releaseCount);
  }, [parsedSources, brushedWeekGrid]);

  // Summary stats for the brushed window
  const summaryStats = useMemo(() => {
    const totalReleases = brushedWeekGrid.reduce((sum, b) => sum + b.count, 0);
    const weeks = brushedWeekGrid.length || 1;
    const avgPerWeek = totalReleases / weeks;
    const avgPerMonth = avgPerWeek * (30 / 7);
    const avgIntervalDays = totalReleases > 1 ? (weeks * 7) / totalReleases : null;

    return { totalReleases, avgPerWeek, avgPerMonth, avgIntervalDays };
  }, [brushedWeekGrid]);

  if (cardData.length === 0) return null;

  return (
    <div className="mt-8 mb-2">
      <RangeNavigator.Root
        min={rangeStart}
        max={rangeEnd}
        buckets={aggregateBuckets}
        sourceBuckets={sourceBuckets}
        value={brushRange}
        onValueChange={setBrushRange}
      >
        <RangeNavigator.Header />
        <RangeNavigator.DetailChart />
        <RangeNavigator.Overview />
        <div className="flex items-center justify-between">
          <RangeNavigator.QuickRanges defaultPreset="3 months" />
          {availableYears.length > 1 && (
            <RangeNavigator.YearSelector
              years={availableYears}
              currentYear={currentYear}
              orgSlug={orgSlug}
            />
          )}
        </div>
      </RangeNavigator.Root>

      {/* Overview stats */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        {([
          { label: "Total Releases", value: String(summaryStats.totalReleases) },
          { label: "Avg Interval", value: summaryStats.avgIntervalDays !== null ? `${Math.round(summaryStats.avgIntervalDays)}d` : "\u2014" },
          { label: "Avg Cadence", value: summaryStats.avgPerMonth >= 1 ? `${Math.round(summaryStats.avgPerMonth)}/mo` : `${Math.round(summaryStats.avgPerWeek)}/wk` },
        ] as const).map((stat) => (
          <div key={stat.label} className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-1">{stat.label}</div>
            <div className="text-xl font-bold text-stone-900 dark:text-stone-100 tabular-nums">{stat.value}</div>
          </div>
        ))}
      </div>

      <CadenceGrid>
        {cardData.map((data) => (
          <Link key={data.slug} href={`/${orgSlug}/${data.slug}`} className="no-underline">
            <CadenceCard.Root data={data} />
          </Link>
        ))}
      </CadenceGrid>
    </div>
  );
}
