"use client";

import { useState, useMemo } from "react";
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

  // Default brush to last 30 days (or full range if data span < 30 days)
  const defaultBrushStart = useMemo(() => {
    const thirtyDaysAgo = new Date(rangeEnd.getTime() - 30 * DAY_MS);
    return thirtyDaysAgo > rangeStart ? thirtyDaysAgo : rangeStart;
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
          latestVersion: source.latestVersion,
          weeklyBuckets: completeBuckets,
          colorIndex: source.colorIndex,
        };
      })
      .sort((a, b) => b.releaseCount - a.releaseCount);
  }, [parsedSources, brushedWeekGrid]);

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
          <RangeNavigator.QuickRanges defaultPreset="1m" />
          {availableYears.length > 1 && (
            <RangeNavigator.YearSelector
              years={availableYears}
              currentYear={currentYear}
              orgSlug={orgSlug}
            />
          )}
        </div>
      </RangeNavigator.Root>

      <CadenceGrid>
        {cardData.map((data) => (
          <CadenceCard.Root key={data.slug} data={data} />
        ))}
      </CadenceGrid>
    </div>
  );
}
