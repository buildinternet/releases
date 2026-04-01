"use client";

import { type CadenceKey, type WeeklyBucket, getCadenceInfo, getProductColor, fmtVersion, DAY_MS, fmtWeek } from "@/lib/cadence";
import { HoverCard } from "@/components/hover-card";

/* ---------- Types ---------- */

/** Default fetch cap per source — counts at this value are likely truncated. */
const FETCH_CAP = 200;

interface CadenceCardData {
  name: string;
  releaseCount: number;
  /** Total release count for the source (before brush filtering). */
  totalReleaseCount: number;
  avgReleasesPerWeek: number;
  earliestVersion: string | null;
  latestVersion: string | null;
  weeklyBuckets: WeeklyBucket[];
  colorIndex: number;
}


/* ---------- Root ---------- */

function Root({
  data,
  className,
  ...props
}: { data: CadenceCardData } & React.ComponentPropsWithoutRef<"article">) {
  const cadence = getCadenceInfo(data.avgReleasesPerWeek);
  const color = getProductColor(data.colorIndex);

  return (
    <article
      data-slot="cadence-card"
      className={`bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg p-4 transition-colors hover:border-blue-400 cursor-pointer ${className ?? ""}`}
      aria-label={`${data.name}: ${data.releaseCount}${data.totalReleaseCount >= FETCH_CAP ? "+" : ""} releases, ${cadence.label} cadence`}
      {...props}
    >
      <Header name={data.name} cadence={cadence} />
      <Stat count={data.releaseCount} capped={data.totalReleaseCount >= FETCH_CAP} color={color} />
      {data.weeklyBuckets.length > 0 && <Sparkline buckets={data.weeklyBuckets} color={color} />}
      <Footer avgPerWeek={data.avgReleasesPerWeek} capped={data.totalReleaseCount >= FETCH_CAP} earliestVersion={data.earliestVersion} latestVersion={data.latestVersion} />
    </article>
  );
}

/* ---------- Header ---------- */

function Header({ name, cadence }: { name: string; cadence: { label: string; key: CadenceKey } }) {
  return (
    <div data-slot="cadence-card-header" className="flex justify-between items-start mb-3">
      <div data-slot="cadence-card-name" className="text-sm font-semibold text-stone-900 dark:text-stone-100">
        {name}
      </div>
      <Badge cadence={cadence.key} label={cadence.label} />
    </div>
  );
}

/* ---------- Badge ---------- */

const badgeStyles: Record<CadenceKey, string> = {
  daily: "bg-green-50 dark:bg-green-950 text-green-600 dark:text-green-400",
  weekly: "bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400",
  biweekly: "bg-purple-50 dark:bg-purple-950 text-purple-600 dark:text-purple-400",
  monthly: "bg-amber-50 dark:bg-amber-950 text-amber-600 dark:text-amber-400",
  sparse: "bg-stone-100 dark:bg-stone-800 text-stone-400",
};

function Badge({ cadence, label }: { cadence: CadenceKey; label: string }) {
  return (
    <span
      data-slot="cadence-badge"
      data-cadence={cadence}
      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide ${badgeStyles[cadence]}`}
    >
      {label}
    </span>
  );
}

/* ---------- Stat ---------- */

function Stat({ count, capped, color }: { count: number; capped: boolean; color: string }) {
  return (
    <>
      <div
        data-slot="cadence-stat"
        className="text-2xl font-bold font-mono mb-0.5"
        style={{ color }}
      >
        {count}{capped && "+"}
      </div>
      <div data-slot="cadence-stat-label" className="text-[11px] text-stone-500 dark:text-stone-400 mb-3">
        releases in window
      </div>
    </>
  );
}

/* ---------- Sparkline ---------- */

function Sparkline({ buckets, color }: { buckets: WeeklyBucket[]; color: string }) {
  const max = Math.max(...buckets.map((b) => b.count), 1);

  return (
    <div
      data-slot="cadence-sparkline"
      className="flex items-end gap-px h-8"
    >
      {buckets.map((bucket, i) => {
        const h = bucket.count > 0 ? Math.max(2, (bucket.count / max) * 32) : 1;
        const weekEnd = new Date(bucket.weekStart.getTime() + 6 * DAY_MS);

        return (
          <HoverCard.Root key={i}>
            <HoverCard.Trigger
              data-slot="cadence-spark-bar"
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

/* ---------- Footer ---------- */

function Footer({
  avgPerWeek,
  capped,
  earliestVersion,
  latestVersion,
}: {
  avgPerWeek: number;
  capped: boolean;
  earliestVersion: string | null;
  latestVersion: string | null;
}) {
  const showRange = earliestVersion && latestVersion && earliestVersion !== latestVersion;
  const versionDisplay = showRange
    ? `${fmtVersion(earliestVersion)} → ${fmtVersion(latestVersion)}`
    : latestVersion
      ? fmtVersion(latestVersion)
      : "\u2014";

  return (
    <div
      data-slot="cadence-card-footer"
      className="flex justify-between mt-3 text-[11px] text-stone-500 dark:text-stone-400"
    >
      <span>{capped ? `${Math.round(avgPerWeek)}+` : Math.round(avgPerWeek)}/week avg</span>
      <span className="truncate ml-2">{versionDisplay}</span>
    </div>
  );
}

/* ---------- Export ---------- */

export const CadenceCard = {
  Root,
  Header,
  Badge,
  Stat,
  Sparkline,
  Footer,
};
