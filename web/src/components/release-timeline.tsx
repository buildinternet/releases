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
  pickWindowVersionRange,
} from "@/lib/cadence";
import { SourceCard, type SourceCadenceData } from "@/components/source-card";
import { RangeNavigator, type SourceBucketEntry } from "@/components/range-navigator";
import { ReleaseHeatmap } from "@/components/release-heatmap";
import { ViewModeToggle, type ViewMode } from "@/components/view-mode-toggle";
import {
  RangePills,
  Stat,
  fmtCadence,
  highlightDaysForPreset,
  type RangePreset,
} from "@/components/timeline-chrome";
import { groupSourcesByProduct } from "@/lib/sources";
import { partitionSdkSources, sdkPreview } from "@/lib/sdk-grouping";
import { SdkSourceCardGroup } from "@/components/sdk-source-card-group";

/** Merge multiple bucket arrays into one, summing counts at each week timestamp. */
function mergeBuckets(bucketArrays: WeeklyBucket[][]): WeeklyBucket[] {
  const map = new Map<number, number>();
  for (const arr of bucketArrays) {
    for (const b of arr) {
      const ts = b.weekStart.getTime();
      map.set(ts, (map.get(ts) ?? 0) + b.count);
    }
  }
  return Array.from(map.entries())
    .toSorted(([a], [b]) => a - b)
    .map(([ts, count]) => ({ weekStart: new Date(ts), count }));
}

interface ReleaseTimelineProps {
  activity: OrgActivity;
  heatmap: OrgHeatmap | null;
  orgSlug: string;
  sources: SourceListItem[];
  products: OrgDetail["products"];
  trackingSince?: string | null;
  overview?: OverviewPageItem | null;
}

/**
 * Render a list of source cards with any loose SDK-kind sources (resolved via
 * source.kind ?? product.kind) folded into a single collapsed group at the
 * bottom. Below the SDK_GROUP_MIN threshold, `partitionSdkSources` returns
 * everything in `flat`, so the group simply doesn't render.
 */
function FlatSourcesWithSdk({
  sources,
  products,
  orgSlug,
  cadenceMap,
  showProductBadge = false,
}: {
  sources: SourceListItem[];
  products: OrgDetail["products"];
  orgSlug: string;
  cadenceMap: Map<string, SourceCadenceData>;
  showProductBadge?: boolean;
}) {
  const { flat, sdk } = partitionSdkSources(sources, products);
  const preview = sdkPreview(
    sdk.map((s) => ({
      name: s.name,
      releaseCount: cadenceMap.get(s.slug)?.totalReleaseCount ?? 0,
    })),
  );

  return (
    <div className="space-y-2">
      {flat.map((source) => (
        <SourceCard
          key={source.slug}
          source={source}
          orgSlug={orgSlug}
          cadence={cadenceMap.get(source.slug)}
          showProductBadge={showProductBadge}
        />
      ))}
      {sdk.length > 0 && (
        <SdkSourceCardGroup count={sdk.length} preview={preview}>
          {sdk.map((source) => (
            <SourceCard
              key={source.slug}
              source={source}
              orgSlug={orgSlug}
              cadence={cadenceMap.get(source.slug)}
              showProductBadge={showProductBadge}
            />
          ))}
        </SdkSourceCardGroup>
      )}
    </div>
  );
}

function ProductGroupedSources({
  sources,
  products,
  orgSlug,
  cadenceMap,
}: {
  sources: SourceListItem[];
  products: OrgDetail["products"];
  orgSlug: string;
  cadenceMap: Map<string, SourceCadenceData>;
}) {
  const { grouped, ungrouped } = groupSourcesByProduct(sources, products);

  return (
    <div className="space-y-6">
      {grouped.map(({ product, sources: srcs }) => (
        <div key={product.slug}>
          <h3 className="text-sm font-semibold text-stone-700 dark:text-stone-300 mb-2">
            {product.name}
          </h3>
          <div className="space-y-2">
            {srcs.map((source) => (
              <SourceCard
                key={source.slug}
                source={source}
                orgSlug={orgSlug}
                cadence={cadenceMap.get(source.slug)}
                showProductBadge={srcs.length > 1 || source.name !== product.name}
              />
            ))}
          </div>
        </div>
      ))}
      {ungrouped.length > 0 && (
        <div>
          {grouped.length > 0 && (
            <h3 className="text-sm font-semibold text-stone-700 dark:text-stone-300 mb-2">
              Other Sources
            </h3>
          )}
          <FlatSourcesWithSdk
            sources={ungrouped}
            products={products}
            orgSlug={orgSlug}
            cadenceMap={cadenceMap}
            showProductBadge={false}
          />
        </div>
      )}
    </div>
  );
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

  // Sources inherit their product's color so chart and card colors are consistent.
  const productColorMap = useMemo(() => {
    if (products.length === 0) return null;
    const sourceToProduct = new Map<string, string>();
    for (const s of sources) {
      if (s.productSlug) sourceToProduct.set(s.slug, s.productSlug);
    }
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
    return { sourceColorMap, productToColor, sourceToProduct };
  }, [products, sources, activity.sources]);

  // Parse buckets once — stable across brush changes
  const parsedSources = useMemo(() => {
    return (
      activity.sources
        .filter((source) => source.releaseCount > 0)
        // oxlint-disable-next-line no-map-spread -- copy-on-write: source is from external API response
        .map((source, i) => ({
          ...source,
          allBuckets: parseBuckets(source.weeklyBuckets),
          colorIndex: productColorMap?.sourceColorMap.get(source.slug) ?? i,
        }))
    );
  }, [activity.sources, productColorMap]);

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

  // Per-product bucket data for stacked bar chart (aggregate sources by product)
  const productBuckets = useMemo<SourceBucketEntry[] | null>(() => {
    if (!productColorMap || parsedSources.length <= 1) return null;

    const { sourceToProduct } = productColorMap;
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
      const merged = mergeBuckets(srcs.map((s) => s.allBuckets));
      const colorIndex = productColorMap.productToColor.get(product.slug) ?? 0;
      result.push({ name: product.name, slug: product.slug, colorIndex, buckets: merged });
    }
    const otherSrcs = groups.get("other");
    if (otherSrcs && otherSrcs.length > 0) {
      const merged = mergeBuckets(otherSrcs.map((s) => s.allBuckets));
      result.push({
        name: "Other",
        slug: "other",
        colorIndex: otherSrcs[0].colorIndex,
        buckets: merged,
      });
    }

    return result.length > 1 ? result : null;
  }, [parsedSources, productColorMap, products]);

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
        const bucketMap = new Map<number, WeeklyBucket>();
        for (const b of source.allBuckets) {
          bucketMap.set(b.weekStart.getTime(), b);
        }

        const completeBuckets: WeeklyBucket[] = brushedWeekGrid.map((week) => {
          const srcBucket = bucketMap.get(week.weekStart.getTime());
          return {
            weekStart: week.weekStart,
            count: srcBucket?.count ?? 0,
            earliestVersion: srcBucket?.earliestVersion ?? null,
            latestVersion: srcBucket?.latestVersion ?? null,
          };
        });

        let brushedCount = 0;
        for (const b of completeBuckets) brushedCount += b.count;
        const { earliest: windowEarliestVersion, latest: windowLatestVersion } =
          pickWindowVersionRange(completeBuckets);

        return {
          name: source.name,
          slug: source.slug,
          releaseCount: brushedCount,
          totalReleaseCount: source.releaseCount,
          avgReleasesPerWeek: source.avgReleasesPerWeek,
          earliestVersion: windowEarliestVersion,
          latestVersion: windowLatestVersion,
          weeklyBuckets: completeBuckets,
          colorIndex: source.colorIndex,
        };
      })
      .toSorted((a, b) => b.releaseCount - a.releaseCount);
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

  // Build a cadence lookup map by slug for the source list
  const cadenceMap = useMemo(() => {
    const map = new Map<string, SourceCadenceData>();
    for (const d of cardData) {
      map.set(d.slug, {
        releaseCount: d.releaseCount,
        totalReleaseCount: d.totalReleaseCount,
        avgReleasesPerWeek: d.avgReleasesPerWeek,
        earliestVersion: d.earliestVersion,
        latestVersion: d.latestVersion,
        weeklyBuckets: d.weeklyBuckets,
        colorIndex: d.colorIndex,
      });
    }
    return map;
  }, [cardData]);

  // Sort sources: primary first, then by cadence release count (desc), non-github before github
  const sortedSources = useMemo(() => {
    return [...sources].toSorted((a, b) => {
      if (a.isPrimary && !b.isPrimary) return -1;
      if (!a.isPrimary && b.isPrimary) return 1;
      const aCadence = cadenceMap.get(a.slug);
      const bCadence = cadenceMap.get(b.slug);
      const aCount = aCadence?.releaseCount ?? 0;
      const bCount = bCadence?.releaseCount ?? 0;
      if (bCount !== aCount) return bCount - aCount;
      if (a.type === "github" && b.type !== "github") return 1;
      if (a.type !== "github" && b.type === "github") return -1;
      return 0;
    });
  }, [sources, cadenceMap]);

  const activeSources = useMemo(() => {
    return sortedSources.filter((s) => {
      const cd = cadenceMap.get(s.slug);
      return cd && cd.releaseCount > 0;
    });
  }, [sortedSources, cadenceMap]);

  if (cardData.length === 0) {
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

  const timelineCard = inHeatmapView ? (
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
  ) : (
    <div className="mb-2">
      {toolbar}
      <div className="mt-3">
        <RangeNavigator.Root
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
      </div>
      <div className="mt-3 mb-5">{statsRow}</div>
    </div>
  );

  return (
    <div className="mt-5 mb-2">
      {timelineCard}

      {overview && <OverviewView page={overview} />}

      <div className="mt-5">
        {products.length > 0 ? (
          <ProductGroupedSources
            sources={activeSources}
            products={products}
            orgSlug={orgSlug}
            cadenceMap={cadenceMap}
          />
        ) : (
          <FlatSourcesWithSdk
            sources={activeSources}
            products={products}
            orgSlug={orgSlug}
            cadenceMap={cadenceMap}
          />
        )}
      </div>
    </div>
  );
}
