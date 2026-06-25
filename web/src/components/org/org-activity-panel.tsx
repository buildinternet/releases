import type { OrgActivityResponse, OrgHeatmapResponse } from "@buildinternet/releases-api-types";
import type { OrgDetail, SourceListItem } from "@/lib/api";
import {
  parseBuckets,
  mergeBucketCounts,
  getCadenceInfo,
  fmtInterval,
  type WeeklyBucket,
} from "@/lib/cadence";
import { fmtCadence } from "@/components/timeline-chrome";
import { Sparkline } from "@/components/sparkline";
import { ReleaseHeatmap } from "@/components/release-heatmap";
import { orgEyebrowClass } from "./ui";

/** Trailing weeks of per-product weekly counts shown in the row sparkline. */
const SPARK_WEEKS = 26;

interface ProductRow {
  slug: string;
  name: string;
  count: number;
  cadence: string;
  perWeek: string;
  spark: number[];
}

/**
 * Overview "Products + Activity" block — the design's Compact list variant.
 * A tight product list (cadence, sparkline, lifetime release count) above an
 * inline activity stat line and the contribution heatmap. Server component: all
 * cadence math is pure and runs at render; `ReleaseHeatmap` is the only client
 * child. Cadence/sparkline data is derived by grouping the activity feed's
 * sources under each product (via `source.productSlug`), mirroring how
 * {@link ReleaseTimeline} colors the timeline.
 */
export function OrgActivityPanel({
  activity,
  heatmap,
  products,
  sources,
  totalReleases,
  avgPerWeek,
  trackingSince,
}: {
  activity: OrgActivityResponse;
  heatmap: OrgHeatmapResponse | null;
  products: OrgDetail["products"];
  sources: SourceListItem[];
  /** Lifetime tracked release count (OrgDetail.releaseCount). */
  totalReleases: number;
  /** Org-wide average releases per week (OrgDetail.avgReleasesPerWeek). */
  avgPerWeek: number;
  trackingSince?: string | null;
}) {
  const sourceToProduct = new Map<string, string>();
  for (const s of sources) if (s.productSlug) sourceToProduct.set(s.slug, s.productSlug);

  // Single O(sources) pass: parse each source's buckets and bucket the source
  // under its product, so the per-product row build below is O(1) lookups.
  const bucketsBySource = new Map<string, WeeklyBucket[]>();
  const avgBySource = new Map<string, number>();
  const productToSources = new Map<string, string[]>();
  for (const src of activity.sources) {
    bucketsBySource.set(src.slug, parseBuckets(src.weeklyBuckets));
    avgBySource.set(src.slug, src.avgReleasesPerWeek);
    const productSlug = sourceToProduct.get(src.slug);
    if (productSlug) {
      const list = productToSources.get(productSlug) ?? [];
      list.push(src.slug);
      productToSources.set(productSlug, list);
    }
  }

  const rows: ProductRow[] = products.map((p) => {
    const memberSlugs = productToSources.get(p.slug) ?? [];
    // `mergeBucketCounts` already returns buckets in ascending week order.
    const merged = mergeBucketCounts(memberSlugs.map((slug) => bucketsBySource.get(slug) ?? []));
    const spark = merged.slice(-SPARK_WEEKS).map((b) => b.count);
    const productAvg = memberSlugs.reduce((sum, slug) => sum + (avgBySource.get(slug) ?? 0), 0);
    return {
      slug: p.slug,
      name: p.name,
      count: p.releaseCount,
      cadence: getCadenceInfo(productAvg).label,
      perWeek: fmtPerWeek(productAvg),
      spark: spark.length > 1 ? spark : [0, 0],
    };
  });

  const interval = avgPerWeek > 0 ? fmtInterval(7 / avgPerWeek) : "—";
  const cadence = fmtCadence(avgPerWeek, avgPerWeek * (30 / 7));

  return (
    <div className="mb-6">
      {/* Products */}
      {rows.length > 0 && (
        <>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className={orgEyebrowClass}>Products</h2>
            <span className="text-[12px] text-[var(--fg-3)]">{rows.length} tracked</span>
          </div>
          <div className="mb-6 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)]">
            {rows.map((r) => (
              <div
                key={r.slug}
                className="flex items-center gap-3.5 border-t border-[var(--line)] px-4 py-3 first:border-t-0"
              >
                <span className="min-w-[120px] text-[14px] font-semibold text-[var(--fg)]">
                  {r.name}
                </span>
                <span className="flex-1 truncate font-mono text-[11.5px] text-[var(--fg-3)]">
                  {r.cadence} · {r.perWeek}
                </span>
                <Sparkline
                  data={r.spark}
                  id={`prod-${r.slug}`}
                  width={72}
                  height={22}
                  color="var(--accent)"
                  className="shrink-0 text-[var(--fg-3)]"
                />
                <span className="w-[42px] text-right font-mono text-[15px] font-semibold text-[var(--fg)]">
                  {r.count}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Activity */}
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className={orgEyebrowClass}>Activity</h2>
        <div className="flex gap-5 font-mono text-[12px] text-[var(--fg-3)]">
          <span>
            <span className="font-medium text-[var(--fg)]">{totalReleases}</span> releases
          </span>
          <span>
            <span className="font-medium text-[var(--fg)]">{interval}</span> interval
          </span>
          <span>
            <span className="font-medium text-[var(--fg)]">{cadence}</span>
          </span>
        </div>
      </div>
      {heatmap && (
        <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-[18px]">
          <ReleaseHeatmap heatmap={heatmap} trackingSince={trackingSince} bare />
        </div>
      )}
    </div>
  );
}

/** "2/wk", "0.5/wk", "6+/wk" — a compact per-week rate for the product row. */
function fmtPerWeek(perWeek: number): string {
  if (perWeek <= 0) return "—";
  if (perWeek >= 10) return `${Math.round(perWeek)}+/wk`;
  if (perWeek >= 1) return `${Math.round(perWeek)}/wk`;
  return `${perWeek.toFixed(1)}/wk`;
}
