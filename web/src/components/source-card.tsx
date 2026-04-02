import Link from "next/link";
import { SourceTypeIcon } from "./source-type-icon";
import { type CadenceKey, type WeeklyBucket, getCadenceInfo, getProductColor, fmtVersion, DAY_MS, fmtWeek, FETCH_CAP } from "@/lib/cadence";
import { HoverCard } from "@/components/hover-card";
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
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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
  } catch { return null; }
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

  return (
    <div className="flex items-end gap-px h-6">
      {buckets.map((bucket, i) => {
        const h = bucket.count > 0 ? Math.max(2, (bucket.count / max) * 24) : 1;
        const weekEnd = new Date(bucket.weekStart.getTime() + 6 * DAY_MS);

        return (
          <HoverCard.Root key={i}>
            <HoverCard.Trigger
              className={`flex-1 rounded-sm min-h-px ${bucket.count === 0 ? "bg-stone-100 dark:bg-stone-800" : ""}`}
              style={{
                height: `${h}px`,
                backgroundColor: bucket.count > 0 ? color : undefined,
                alignSelf: "flex-end",
              }}
            />
            {bucket.count > 0 && (
              <HoverCard.Content className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-lg shadow-lg px-3 py-2 min-w-[140px]">
                <div className="text-[11px] font-medium text-stone-500 dark:text-stone-400 mb-1">
                  {fmtWeek(bucket.weekStart)} – {fmtWeek(weekEnd)}
                </div>
                <div className="text-sm font-semibold" style={{ color }}>
                  {bucket.count} {bucket.count === 1 ? "release" : "releases"}
                </div>
              </HoverCard.Content>
            )}
          </HoverCard.Root>
        );
      })}
    </div>
  );
}

export function SourceCard({ source, orgSlug, cadence }: { source: SourceListItem; orgSlug?: string; cadence?: SourceCadenceData }) {
  const href = orgSlug ? `/${orgSlug}/${source.slug}` : `/source/${source.slug}`;
  const cadenceInfo = cadence ? getCadenceInfo(cadence.avgReleasesPerWeek) : null;
  const color = cadence ? getProductColor(cadence.colorIndex) : undefined;
  const capped = cadence ? cadence.totalReleaseCount >= FETCH_CAP : false;

  return (
    <Link href={href} className="block bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg p-4 hover:border-stone-300 dark:hover:border-stone-600 transition-colors">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-[15px] text-stone-900 dark:text-stone-100">{source.name}</span>
          {source.isPrimary && (
            <span className="text-[10px] font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400 bg-stone-100 dark:bg-stone-800 px-1.5 py-0.5 rounded">Primary</span>
          )}
          {cadenceInfo && (
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide ${badgeStyles[cadenceInfo.key]}`}>
              {cadenceInfo.label}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {cadence && color && (
            <span className="text-sm font-bold font-mono" style={{ color }}>
              {cadence.releaseCount}{capped && "+"}
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
          {source.latestDate && <>{source.latestVersion ? " · " : ""}{formatDate(source.latestDate)}</>}
          {source.releaseCount > 0 && <>{(source.latestVersion || source.latestDate) ? " · " : ""}{source.releaseCount >= FETCH_CAP ? `${FETCH_CAP}+` : source.releaseCount} releases</>}
        </div>
      )}
      {cadence && cadence.weeklyBuckets.length > 0 && color && (
        <div className="mt-3">
          <InlineSparkline buckets={cadence.weeklyBuckets} color={color} />
          <div className="flex justify-between mt-1.5 text-[11px] text-stone-500 dark:text-stone-400">
            <span>{capped ? `${Math.round(cadence.avgReleasesPerWeek)}+` : Math.round(cadence.avgReleasesPerWeek)}/week avg</span>
            <span className="truncate ml-2">
              {cadence.earliestVersion && cadence.latestVersion && cadence.earliestVersion !== cadence.latestVersion
                ? `${fmtVersion(cadence.earliestVersion)} → ${fmtVersion(cadence.latestVersion)}`
                : cadence.latestVersion
                  ? fmtVersion(cadence.latestVersion)
                  : ""}
            </span>
          </div>
        </div>
      )}
    </Link>
  );
}
