"use client";

import { useState, useMemo } from "react";
import { type OrgActivity, type OrgHeatmap, type SourceListItem, type OrgDetail } from "@/lib/api";
import { type WeeklyBucket, WEEK_MS, DAY_MS, parseBuckets, fmtInterval } from "@/lib/cadence";
import { SourceCard, type SourceCadenceData } from "@/components/source-card";
import { InfoTooltip } from "@/components/info-tooltip";
import { RangeNavigator, type SourceBucketEntry } from "@/components/range-navigator";
import { ReleaseHeatmap } from "@/components/release-heatmap";
import { ViewModeToggle, type ViewMode } from "@/components/view-mode-toggle";
import { groupSourcesByProduct } from "@/lib/sources";

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
    .sort(([a], [b]) => a - b)
    .map(([ts, count]) => ({ weekStart: new Date(ts), count }));
}

interface ReleaseTimelineProps {
  activity: OrgActivity;
  heatmap: OrgHeatmap | null;
  orgSlug: string;
  sources: SourceListItem[];
  products: OrgDetail["products"];
  trackingSince?: string | null;
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
          <h3 className="text-sm font-semibold text-stone-700 dark:text-stone-300 mb-2">{product.name}</h3>
          <div className="space-y-2">
            {srcs.map((source) => (
              <SourceCard key={source.slug} source={source} orgSlug={orgSlug} cadence={cadenceMap.get(source.slug)} showProductBadge={srcs.length > 1 || source.name !== product.name} />
            ))}
          </div>
        </div>
      ))}
      {ungrouped.length > 0 && (
        <div>
          {grouped.length > 0 && (
            <h3 className="text-sm font-semibold text-stone-700 dark:text-stone-300 mb-2">Other Sources</h3>
          )}
          <div className="space-y-2">
            {ungrouped.map((source) => (
              <SourceCard key={source.slug} source={source} orgSlug={orgSlug} cadence={cadenceMap.get(source.slug)} showProductBadge={false} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function ReleaseTimeline({ activity, heatmap, orgSlug, sources, products, trackingSince }: ReleaseTimelineProps) {
  const [viewMode, setViewMode] = useState<ViewMode>(heatmap ? "heatmap" : "chart");

  const rangeStart = useMemo(() => new Date(activity.range.from), [activity.range.from]);
  const rangeEnd = useMemo(() => new Date(activity.range.to), [activity.range.to]);

  const aggregateBuckets = useMemo(() => parseBuckets(activity.aggregateWeekly), [activity.aggregateWeekly]);

  // Default brush to last 3 months (or full range if data span < 91 days)
  const defaultBrushStart = useMemo(() => {
    const threeMonthsAgo = new Date(rangeEnd.getTime() - 91 * DAY_MS);
    return threeMonthsAgo > rangeStart ? threeMonthsAgo : rangeStart;
  }, [rangeStart, rangeEnd]);

  const [brushRange, setBrushRange] = useState<[Date, Date]>([defaultBrushStart, rangeEnd]);

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
    return activity.sources
      .filter((source) => source.releaseCount > 0)
      .map((source, i) => ({
        ...source,
        allBuckets: parseBuckets(source.weeklyBuckets),
        colorIndex: productColorMap?.sourceColorMap.get(source.slug) ?? i,
      }));
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
      result.push({ name: "Other", slug: "other", colorIndex: otherSrcs[0].colorIndex, buckets: merged });
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
        let windowEarliestVersion: string | null = null;
        let windowLatestVersion: string | null = null;
        for (const b of completeBuckets) {
          brushedCount += b.count;
          if (b.earliestVersion && !windowEarliestVersion) windowEarliestVersion = b.earliestVersion;
          if (b.latestVersion) windowLatestVersion = b.latestVersion;
        }

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
    return [...sources].sort((a, b) => {
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

  if (cardData.length === 0) return null;

  return (
    <div className="mt-5 mb-2">
      {heatmap && (
        <ViewModeToggle viewMode={viewMode} onViewModeChange={setViewMode} />
      )}

      {/* Heatmap view */}
      {viewMode === "heatmap" && heatmap ? (
        <ReleaseHeatmap heatmap={heatmap} trackingSince={trackingSince} />
      ) : (
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
      )}

      <div className={`grid grid-cols-1 ${viewMode === "heatmap" ? "sm:grid-cols-2" : "sm:grid-cols-3"} gap-3 mt-4 mb-2`}>
        {([
          ...(viewMode !== "heatmap" ? [{ label: "Releases", value: String(summaryStats.totalReleases), tooltip: "Total releases in the selected timeline range." }] : []),
          { label: "Avg Interval", value: summaryStats.avgIntervalDays !== null ? fmtInterval(summaryStats.avgIntervalDays) : "\u2014", tooltip: "Average time between releases in the selected range." },
          { label: "Avg Cadence", value: summaryStats.avgPerMonth >= 1 ? `${Math.round(summaryStats.avgPerMonth)}/mo` : `${Math.round(summaryStats.avgPerWeek)}/wk`, tooltip: "Average release frequency in the selected range." },
        ]).map((stat) => (
          <div key={stat.label} className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-1 flex items-center gap-1">
              {stat.label}
              <InfoTooltip text={stat.tooltip} />
            </div>
            <div className="text-xl font-bold text-stone-900 dark:text-stone-100 tabular-nums">{stat.value}</div>
          </div>
        ))}
      </div>

      <div className="mt-5">
        {products.length > 0 ? (
          <ProductGroupedSources
            sources={activeSources}
            products={products}
            orgSlug={orgSlug}
            cadenceMap={cadenceMap}
          />
        ) : (
          <div className="space-y-2">
            {activeSources.map((source) => (
              <SourceCard key={source.slug} source={source} orgSlug={orgSlug} cadence={cadenceMap.get(source.slug)} />
            ))}
          </div>
        )}
      </div>

    </div>
  );
}
