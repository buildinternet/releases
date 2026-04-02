"use client";

import { useState, useMemo } from "react";
import { type OrgActivity, type SourceListItem, type OrgDetail } from "@/lib/api";
import { type WeeklyBucket, WEEK_MS, DAY_MS, parseBuckets, fmtInterval } from "@/lib/cadence";
import { SourceCard, type SourceCadenceData } from "@/components/source-card";
import { RangeNavigator, type SourceBucketEntry } from "@/components/range-navigator";
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
  orgSlug: string;
  sources: SourceListItem[];
  products: OrgDetail["products"];
  children?: React.ReactNode;
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

export function ReleaseTimeline({ activity, orgSlug, sources, products, children }: ReleaseTimelineProps) {
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

  // Per-product bucket data for stacked bar chart (aggregate sources by product)
  const productBuckets = useMemo<SourceBucketEntry[] | null>(() => {
    if (products.length === 0 || parsedSources.length <= 1) return null;

    // Build a slug→productSlug lookup from the sources prop
    const sourceToProduct = new Map<string, string>();
    for (const s of sources) {
      if (s.productSlug) sourceToProduct.set(s.slug, s.productSlug);
    }

    // Group parsed sources by product (ungrouped → "other")
    const groups = new Map<string, typeof parsedSources>();
    for (const src of parsedSources) {
      const key = sourceToProduct.get(src.slug) ?? "other";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(src);
    }

    // Merge buckets within each product group
    let colorIdx = 0;
    const result: SourceBucketEntry[] = [];
    for (const product of products) {
      const srcs = groups.get(product.slug);
      if (!srcs || srcs.length === 0) continue;
      const merged = mergeBuckets(srcs.map((s) => s.allBuckets));
      result.push({ name: product.name, slug: product.slug, colorIndex: colorIdx++, buckets: merged });
    }
    const otherSrcs = groups.get("other");
    if (otherSrcs && otherSrcs.length > 0) {
      const merged = mergeBuckets(otherSrcs.map((s) => s.allBuckets));
      result.push({ name: "Other", slug: "other", colorIndex: colorIdx++, buckets: merged });
    }

    return result.length > 1 ? result : null;
  }, [parsedSources, products, sources]);

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
        const bucketMap = new Map<number, WeeklyBucket>();
        for (const b of source.allBuckets) {
          bucketMap.set(b.weekStart.getTime(), b);
        }

        // Map onto the canonical grid so all cards have the same number of bars
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

  if (cardData.length === 0) return null;

  return (
    <div className="mt-8 mb-2">
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

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        {([
          { label: "Total Releases", value: String(summaryStats.totalReleases) },
          { label: "Avg Interval", value: summaryStats.avgIntervalDays !== null ? fmtInterval(summaryStats.avgIntervalDays) : "\u2014" },
          { label: "Avg Cadence", value: summaryStats.avgPerMonth >= 1 ? `${Math.round(summaryStats.avgPerMonth)}/mo` : `${Math.round(summaryStats.avgPerWeek)}/wk` },
        ] as const).map((stat) => (
          <div key={stat.label} className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-1">{stat.label}</div>
            <div className="text-xl font-bold text-stone-900 dark:text-stone-100 tabular-nums">{stat.value}</div>
          </div>
        ))}
      </div>

      {children}

      <div className="mt-5">
        {products.length > 0 ? (
          <ProductGroupedSources
            sources={sortedSources}
            products={products}
            orgSlug={orgSlug}
            cadenceMap={cadenceMap}
          />
        ) : (
          <div className="space-y-2">
            {sortedSources.map((source) => (
              <SourceCard key={source.slug} source={source} orgSlug={orgSlug} cadence={cadenceMap.get(source.slug)} />
            ))}
          </div>
        )}
      </div>

    </div>
  );
}
