"use client";

import { useState, useMemo } from "react";
import { type OrgActivity } from "@/lib/api";
import { type WeeklyBucket } from "@/lib/cadence";
import { CadenceCard } from "@/components/cadence-card";
import { CadenceGrid } from "@/components/cadence-grid";
import { RangeNavigator } from "@/components/range-navigator";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function parseBuckets(raw: Array<{ weekStart: string; count: number }>): WeeklyBucket[] {
  return raw.map((b) => ({ weekStart: new Date(b.weekStart), count: b.count }));
}

export function ReleaseTimeline({ activity }: { activity: OrgActivity }) {
  const rangeStart = useMemo(() => new Date(activity.range.from), [activity.range.from]);
  const rangeEnd = useMemo(() => new Date(activity.range.to), [activity.range.to]);

  const aggregateBuckets = useMemo(() => parseBuckets(activity.aggregateWeekly), [activity.aggregateWeekly]);

  const [brushRange, setBrushRange] = useState<[Date, Date]>([rangeStart, rangeEnd]);

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

  // Brush-sensitive — filters pre-parsed buckets without re-creating Date objects
  const cardData = useMemo(() => {
    return parsedSources
      .map((source) => {
        const brushedBuckets = source.allBuckets.filter((b) => {
          const bEnd = new Date(b.weekStart.getTime() + WEEK_MS);
          return bEnd > brushRange[0] && b.weekStart < brushRange[1];
        });

        const brushedCount = brushedBuckets.reduce((sum, b) => sum + b.count, 0);

        return {
          name: source.name,
          slug: source.slug,
          releaseCount: brushedCount,
          totalReleaseCount: source.releaseCount,
          avgReleasesPerWeek: source.avgReleasesPerWeek,
          latestVersion: source.latestVersion,
          weeklyBuckets: brushedBuckets,
          colorIndex: source.colorIndex,
        };
      })
      .sort((a, b) => b.releaseCount - a.releaseCount);
  }, [parsedSources, brushRange]);

  if (cardData.length === 0) return null;

  return (
    <div className="mt-8 mb-2">
      <RangeNavigator.Root
        min={rangeStart}
        max={rangeEnd}
        buckets={aggregateBuckets}
        value={brushRange}
        onValueChange={setBrushRange}
      >
        <RangeNavigator.Header />
        <RangeNavigator.Chart />
        <RangeNavigator.MonthLabels />
        <RangeNavigator.Brush />
        <RangeNavigator.QuickRanges />
      </RangeNavigator.Root>

      <CadenceGrid>
        {cardData.map((data) => (
          <CadenceCard.Root key={data.slug} data={data} />
        ))}
      </CadenceGrid>
    </div>
  );
}
