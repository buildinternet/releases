import Link from "next/link";
import type { OrgDetail } from "@/lib/api";
import { productPath } from "@/lib/links";
import { type WeeklyBucket, fmtVersion, getProductColor } from "@/lib/cadence";
import { CadenceBadge, InlineSparkline } from "@/components/cadence-chrome";

export interface ProductCadenceData {
  releaseCount: number;
  totalReleaseCount: number;
  avgReleasesPerWeek: number;
  latestVersion: string | null;
  weeklyBuckets: WeeklyBucket[];
  colorIndex: number;
  capped: boolean;
}

/**
 * Hub product cards on the org Overview page. Renders only when the org has
 * 2+ products — at ≤1 product the org page is already the single product's
 * feed (and the product page 301s home), so a grid would be redundant.
 *
 * When `cadenceBySlug` is provided (from ReleaseTimeline's brush window),
 * chips show cadence badge, sparkline, windowed release count, avg/week, and
 * latest version.
 */
export function ProductGrid({
  orgSlug,
  products,
  cadenceBySlug,
}: {
  orgSlug: string;
  products: OrgDetail["products"];
  cadenceBySlug?: Map<string, ProductCadenceData>;
}) {
  if (products.length < 2) return null;

  return (
    <div>
      <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-3">
        Products
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {products.map((p) => {
          const cadence = cadenceBySlug?.get(p.slug);
          const color = cadence ? getProductColor(cadence.colorIndex) : undefined;
          const hasActivity = cadence != null && cadence.releaseCount > 0;
          const latestLabel =
            hasActivity && cadence.latestVersion ? fmtVersion(cadence.latestVersion) : null;
          const avgLabel = hasActivity
            ? `${cadence.capped ? `${Math.round(cadence.avgReleasesPerWeek)}+` : Math.round(cadence.avgReleasesPerWeek)}/week avg`
            : null;
          const byline = [avgLabel, latestLabel].filter(Boolean).join(" · ");

          return (
            <Link
              key={p.slug}
              href={productPath(orgSlug, p.slug)}
              className="block rounded-lg border border-stone-200 dark:border-stone-800 hover:border-stone-300 dark:hover:border-stone-700 bg-white dark:bg-stone-900 px-3 py-2.5 transition-colors"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium text-stone-800 dark:text-stone-200 truncate">
                    {p.name}
                  </span>
                  {hasActivity && <CadenceBadge avgPerWeek={cadence.avgReleasesPerWeek} />}
                </div>
                {hasActivity && color && cadence.weeklyBuckets.length > 0 && (
                  <div className="flex items-center gap-3 shrink-0">
                    <InlineSparkline buckets={cadence.weeklyBuckets} color={color} />
                    <span className="text-sm font-bold font-mono" style={{ color }}>
                      {cadence.releaseCount}
                      {cadence.capped && "+"}
                    </span>
                  </div>
                )}
              </div>
              {byline && (
                <div className="mt-1.5 text-[11px] text-stone-500 dark:text-stone-400 truncate">
                  {byline}
                </div>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
