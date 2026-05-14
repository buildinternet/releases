import Link from "next/link";
import { ViewTransition } from "react";
import { SourceTypeIcon } from "./source-type-icon";
import {
  type CadenceKey,
  type WeeklyBucket,
  getCadenceInfo,
  getProductColor,
  fmtVersion,
  DAY_MS,
  fmtWeek,
  FETCH_CAP,
} from "@/lib/cadence";
import { HoverCard } from "@/components/hover-card";
import { VersionRangeDiff } from "@/components/version-range-diff";
import type { SourceListItem } from "@/lib/api";

export interface SourceCadenceData {
  releaseCount: number;
  totalReleaseCount: number;
  avgReleasesPerWeek: number;
  earliestVersion: string | null;
  latestVersion: string | null;
  weeklyBuckets: WeeklyBucket[];
  colorIndex: number;
}

function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function shortUrl(url?: string) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, "");
    // GitHub: show owner/repo shorthand instead of full URL
    if (u.hostname === "github.com") {
      return path.replace(/^\//, "") || u.hostname;
    }
    return path && path !== "/" ? u.hostname + path : u.hostname;
  } catch {
    return null;
  }
}

const badgeStyles: Record<CadenceKey, string> = {
  daily: "bg-green-50 dark:bg-green-950 text-green-600 dark:text-green-400",
  weekly: "bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400",
  biweekly: "bg-purple-50 dark:bg-purple-950 text-purple-600 dark:text-purple-400",
  monthly: "bg-amber-50 dark:bg-amber-950 text-amber-600 dark:text-amber-400",
  sparse: "bg-stone-100 dark:bg-stone-800 text-stone-400",
};

function InlineSparkline({ buckets, color }: { buckets: WeeklyBucket[]; color: string }) {
  const max = Math.max(...buckets.map((b) => b.count), 1);
  const n = buckets.length;
  const W = 100;
  const H = 20;
  const PAD_Y = 2;

  const xFor = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const yFor = (count: number) => H - PAD_Y - (count / max) * (H - PAD_Y * 2);

  const points = buckets
    .map((b, i) => `${xFor(i).toFixed(2)},${yFor(b.count).toFixed(2)}`)
    .join(" ");

  const tooltipLatest = buckets.length > 0 ? buckets[buckets.length - 1] : null;
  const tooltipFirst = buckets[0];
  const tooltipEnd = tooltipLatest
    ? new Date(tooltipLatest.weekStart.getTime() + 6 * DAY_MS)
    : null;
  const total = buckets.reduce((sum, b) => sum + b.count, 0);

  return (
    <HoverCard.Root>
      <HoverCard.Trigger className="block w-16 h-4 shrink-0">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="w-full h-full overflow-visible"
          aria-hidden
        >
          <polyline
            points={points}
            fill="none"
            stroke={color}
            strokeOpacity={0.55}
            strokeWidth={1.25}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </HoverCard.Trigger>
      {tooltipLatest && tooltipFirst && tooltipEnd && (
        <HoverCard.Content className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-lg shadow-lg px-3 py-2 min-w-[160px]">
          <div className="text-[11px] font-medium text-stone-500 dark:text-stone-400 mb-1">
            {fmtWeek(tooltipFirst.weekStart)} – {fmtWeek(tooltipEnd)}
          </div>
          <div className="text-sm font-semibold" style={{ color }}>
            {total} {total === 1 ? "release" : "releases"}
          </div>
        </HoverCard.Content>
      )}
    </HoverCard.Root>
  );
}

export function SourceCard({
  source,
  orgSlug,
  cadence,
  showProductBadge = true,
}: {
  source: SourceListItem;
  orgSlug?: string;
  cadence?: SourceCadenceData;
  showProductBadge?: boolean;
}) {
  const href = orgSlug ? `/${orgSlug}/${source.slug}` : `/source/${source.slug}`;
  const transitionName = `src-${orgSlug ?? "_"}-${source.slug}`;
  const cadenceInfo = cadence ? getCadenceInfo(cadence.avgReleasesPerWeek) : null;
  const color = cadence ? getProductColor(cadence.colorIndex) : undefined;
  const capped = cadence ? cadence.totalReleaseCount >= FETCH_CAP : false;

  return (
    <Link
      href={href}
      className="block bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg p-4 hover:border-stone-300 dark:hover:border-stone-600 transition-colors"
    >
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <ViewTransition name={transitionName} default="none">
            <span className="font-semibold text-[15px] text-stone-900 dark:text-stone-100">
              {source.name}
            </span>
          </ViewTransition>
          {source.isPrimary && (
            <span className="text-[10px] font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400 bg-stone-100 dark:bg-stone-800 px-1.5 py-0.5 rounded">
              Primary
            </span>
          )}
          {showProductBadge && source.productName && (
            <span className="text-[10px] font-medium text-stone-400 dark:text-stone-500 bg-stone-50 dark:bg-stone-800 px-1.5 py-0.5 rounded">
              {source.productName}
            </span>
          )}
          {cadenceInfo && (
            <span
              className={`text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide ${badgeStyles[cadenceInfo.key]}`}
            >
              {cadenceInfo.label}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {cadence && color && cadence.weeklyBuckets.length > 0 && (
            <InlineSparkline buckets={cadence.weeklyBuckets} color={color} />
          )}
          {cadence && color && (
            <span className="text-sm font-bold font-mono" style={{ color }}>
              {cadence.releaseCount}
              {capped && "+"}
            </span>
          )}
          <SourceTypeIcon type={source.type} />
        </div>
      </div>
      {source.url && (
        <div className="text-xs text-stone-400 dark:text-stone-500 mt-1.5">
          {shortUrl(source.url)}
        </div>
      )}
      {!cadence && (source.latestVersion || source.latestDate || source.releaseCount > 0) && (
        <div className="text-xs text-stone-400 dark:text-stone-500 mt-0.5">
          {source.latestVersion && <>Latest: {source.latestVersion}</>}
          {source.latestDate && (
            <>
              {source.latestVersion ? " · " : ""}
              {formatDate(source.latestDate)}
            </>
          )}
          {source.releaseCount > 0 && (
            <>
              {source.latestVersion || source.latestDate ? " · " : ""}
              {source.releaseCount >= FETCH_CAP ? `${FETCH_CAP}+` : source.releaseCount} releases
            </>
          )}
        </div>
      )}
      {cadence && cadence.weeklyBuckets.length > 0 && (
        <div className="flex justify-between mt-2 text-[11px] text-stone-500 dark:text-stone-400">
          <span>
            {capped
              ? `${Math.round(cadence.avgReleasesPerWeek)}+`
              : Math.round(cadence.avgReleasesPerWeek)}
            /week avg
          </span>
          <span className="truncate ml-2">
            {cadence.earliestVersion &&
            cadence.latestVersion &&
            cadence.earliestVersion !== cadence.latestVersion ? (
              <VersionRangeDiff
                from={fmtVersion(cadence.earliestVersion)}
                to={fmtVersion(cadence.latestVersion)}
              />
            ) : cadence.latestVersion ? (
              fmtVersion(cadence.latestVersion)
            ) : (
              ""
            )}
          </span>
        </div>
      )}
    </Link>
  );
}
