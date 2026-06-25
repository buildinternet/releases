"use client";

import { useState, useMemo, useCallback } from "react";
import {
  type OrgActivity,
  type OrgHeatmap,
  type OverviewPageItem,
  type SourceListItem,
  type OrgDetail,
} from "@/lib/api";
import { OverviewView } from "@/components/overview-view";
import {
  type WeeklyBucket,
  WEEK_MS,
  DAY_MS,
  parseBuckets,
  fmtInterval,
  fmtCadence,
  pickWindowVersionRange,
  mergeBucketCounts,
  mergeWeeklyBuckets,
  FETCH_CAP,
} from "@/lib/cadence";
import { RangeNavigator, type SourceBucketEntry } from "@/components/range-navigator";
import { ReleaseHeatmap } from "@/components/release-heatmap";
import { ViewModeToggle, type ViewMode } from "@/components/view-mode-toggle";
import {
  RangePills,
  Stat,
  highlightDaysForPreset,
  type RangePreset,
} from "@/components/timeline-chrome";
import { ProductGrid, type ProductCadenceData } from "@/components/product-grid";

interface ReleaseTimelineProps {
  activity: OrgActivity;
  heatmap: OrgHeatmap | null;
  orgSlug: string;
  /** Org source list — supplies `productSlug` for product color + chip rollups. */
  sources: SourceListItem[];
  products: OrgDetail["products"];
  trackingSince?: string | null;
  overview?: OverviewPageItem | null;
}

/** Align a source's weekly buckets onto the brushed week grid. */
function bucketsForBrushGrid(
  allBuckets: WeeklyBucket[],
  brushedWeekGrid: WeeklyBucket[],
): WeeklyBucket[] {
  const bucketMap = new Map<number, WeeklyBucket>();
  for (const b of allBuckets) {
    bucketMap.set(b.weekStart.getTime(), b);
  }
  return brushedWeekGrid.map((week) => {
    const srcBucket = bucketMap.get(week.weekStart.getTime());
    return {
      weekStart: week.weekStart,
      count: srcBucket?.count ?? 0,
      earliestVersion: srcBucket?.earliestVersion ?? null,
      latestVersion: srcBucket?.latestVersion ?? null,
    };
  });
}

export function ReleaseTimeline({
  activity,
  heatmap,
  orgSlug,
  sources,
  products,
  trackingSince,
  overview,
}: ReleaseTimelineProps) {
  const [viewMode, setViewMode] = useState<ViewMode>(heatmap ? "heatmap" : "chart");

  const rangeStart = useMemo(() => new Date(activity.range.from), [activity.range.from]);
  const rangeEnd = useMemo(() => new Date(activity.range.to), [activity.range.to]);

  const aggregateBuckets = useMemo(
    () => parseBuckets(activity.aggregateWeekly),
    [activity.aggregateWeekly],
  );

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

  const sourceToProduct = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sources) {
      if (s.productSlug) map.set(s.slug, s.productSlug);
    }
    return map;
  }, [sources]);

  // Sources inherit their product's color so chart and chip colors are consistent.
  const productColorMap = useMemo(() => {
    if (products.length === 0) return null;

    const activeSources = activity.sources.filter((s) => s.releaseCount > 0);
    const activeProductSlugs = new Set<string>();
    for (const src of activeSources) {
      const ps = sourceToProduct.get(src.slug);
      if (ps) activeProductSlugs.add(ps);
    }

    let colorIdx = 0;
    const productToColor = new Map<string, number>();
    for (const product of products) {
      if (activeProductSlugs.has(product.slug)) {
        productToColor.set(product.slug, colorIdx++);
      }
    }

    const sourceColorMap = new Map<string, number>();
    for (const src of activeSources) {
      const ps = sourceToProduct.get(src.slug);
      if (ps && productToColor.has(ps)) {
        sourceColorMap.set(src.slug, productToColor.get(ps)!);
      } else {
        sourceColorMap.set(src.slug, colorIdx++);
      }
    }

    return { sourceColorMap, productToColor };
  }, [products, sourceToProduct, activity.sources]);

  const parsedSources = useMemo(() => {
    return activity.sources
      .filter((source) => source.releaseCount > 0)
      .map((source, i) => ({
        slug: source.slug,
        name: source.name,
        releaseCount: source.releaseCount,
        allBuckets: parseBuckets(source.weeklyBuckets),
        colorIndex: productColorMap?.sourceColorMap.get(source.slug) ?? i,
      }));
  }, [activity.sources, productColorMap]);

  const sourceBuckets = useMemo<SourceBucketEntry[] | null>(() => {
    if (parsedSources.length <= 1) return null;
    return parsedSources.map((src) => ({
      name: src.name,
      slug: src.slug,
      colorIndex: src.colorIndex,
      buckets: src.allBuckets,
    }));
  }, [parsedSources]);

  const productBuckets = useMemo<SourceBucketEntry[] | null>(() => {
    if (!productColorMap || parsedSources.length <= 1) return null;

    const groups = new Map<string, typeof parsedSources>();
    for (const src of parsedSources) {
      const key = sourceToProduct.get(src.slug) ?? "other";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(src);
    }

    const result: SourceBucketEntry[] = [];
    for (const product of products) {
      const srcs = groups.get(product.slug);
      if (!srcs || srcs.length === 0) continue;
      result.push({
        name: product.name,
        slug: product.slug,
        colorIndex: productColorMap.productToColor.get(product.slug) ?? 0,
        buckets: mergeBucketCounts(srcs.map((s) => s.allBuckets)),
      });
    }

    const otherSrcs = groups.get("other");
    if (otherSrcs && otherSrcs.length > 0) {
      result.push({
        name: "Other",
        slug: "other",
        colorIndex: otherSrcs[0].colorIndex,
        buckets: mergeBucketCounts(otherSrcs.map((s) => s.allBuckets)),
      });
    }

    return result.length > 1 ? result : null;
  }, [parsedSources, productColorMap, products, sourceToProduct]);

  const brushedWeekGrid = useMemo(() => {
    return aggregateBuckets.filter((b) => {
      const bEnd = new Date(b.weekStart.getTime() + WEEK_MS);
      return bEnd > brushRange[0] && b.weekStart < brushRange[1];
    });
  }, [aggregateBuckets, brushRange]);

  const productCadenceBySlug = useMemo(() => {
    if (products.length < 2 || !productColorMap) return undefined;

    const groups = new Map<string, typeof parsedSources>();
    for (const src of parsedSources) {
      const productSlug = sourceToProduct.get(src.slug);
      if (!productSlug) continue;
      if (!groups.has(productSlug)) groups.set(productSlug, []);
      groups.get(productSlug)!.push(src);
    }

    const map = new Map<string, ProductCadenceData>();
    const weeks = brushedWeekGrid.length || 1;

    for (const product of products) {
      const srcs = groups.get(product.slug);
      if (!srcs || srcs.length === 0) continue;

      const weeklyBuckets = mergeWeeklyBuckets(
        srcs.map((s) => bucketsForBrushGrid(s.allBuckets, brushedWeekGrid)),
      );
      const releaseCount = weeklyBuckets.reduce((sum, b) => sum + b.count, 0);
      const totalReleaseCount = srcs.reduce((sum, s) => sum + s.releaseCount, 0);
      const capped =
        totalReleaseCount >= FETCH_CAP || srcs.some((s) => s.releaseCount >= FETCH_CAP);
      const { latest: latestVersion } = pickWindowVersionRange(weeklyBuckets);

      map.set(product.slug, {
        releaseCount,
        totalReleaseCount,
        avgReleasesPerWeek: releaseCount / weeks,
        latestVersion,
        weeklyBuckets,
        colorIndex: productColorMap.productToColor.get(product.slug) ?? srcs[0].colorIndex,
        capped,
      });
    }

    return map;
  }, [products, productColorMap, parsedSources, brushedWeekGrid, sourceToProduct]);

  const summaryStats = useMemo(() => {
    const totalReleases = brushedWeekGrid.reduce((sum, b) => sum + b.count, 0);
    const weeks = brushedWeekGrid.length || 1;
    const avgPerWeek = totalReleases / weeks;
    const avgPerMonth = avgPerWeek * (30 / 7);
    const avgIntervalDays = totalReleases > 1 ? (weeks * 7) / totalReleases : null;

    return { totalReleases, avgPerWeek, avgPerMonth, avgIntervalDays };
  }, [brushedWeekGrid]);

  if (parsedSources.length === 0) {
    return overview ? (
      <div className="mt-5 mb-2">
        <OverviewView page={overview} />
      </div>
    ) : null;
  }

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
      <Stat
        label="Avg Interval"
        value={
          summaryStats.avgIntervalDays !== null
            ? fmtInterval(summaryStats.avgIntervalDays)
            : "\u2014"
        }
      />
      <Stat label="Avg Cadence" value={cadenceLabel} />
    </div>
  );

  const timelineCard = (
    <div className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg px-5 py-4">
      {toolbar}
      <div className="mt-4">
        {inHeatmapView ? (
          <ReleaseHeatmap
            heatmap={heatmap!}
            trackingSince={trackingSince}
            highlightDays={heatmapHighlightDays}
            bare
          />
        ) : (
          <RangeNavigator.Root
            bare
            min={rangeStart}
            max={rangeEnd}
            buckets={aggregateBuckets}
            sourceBuckets={sourceBuckets}
            productBuckets={productBuckets}
            value={brushRange}
            onValueChange={setBrushRange}
          >
            <RangeNavigator.Header />
            <RangeNavigator.DetailChart />
            <RangeNavigator.Overview />
            <RangeNavigator.QuickRanges defaultPreset="3 months" />
          </RangeNavigator.Root>
        )}
      </div>
      <div className="mt-3 pt-3 border-t border-stone-200 dark:border-stone-800">{statsRow}</div>
    </div>
  );

  return (
    <div className="mt-5 mb-2 space-y-5">
      <ProductGrid orgSlug={orgSlug} products={products} cadenceBySlug={productCadenceBySlug} />
      {timelineCard}
      {overview && <OverviewView page={overview} />}
    </div>
  );
}
