"use client";

import { type CadenceKey, type WeeklyBucket, getCadenceInfo, getProductColor, DAY_MS, fmtWeek } from "@/lib/cadence";
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
      className={`bg-white border border-stone-200 rounded-lg p-4 transition-colors hover:border-blue-400 ${className ?? ""}`}
      aria-label={`${data.name}: ${data.releaseCount}${data.totalReleaseCount >= FETCH_CAP ? "+" : ""} releases, ${cadence.label} cadence`}
      {...props}
    >
      <Header name={data.name} cadence={cadence} />
      <Stat count={data.releaseCount} capped={data.totalReleaseCount >= FETCH_CAP} color={color} />
      {data.weeklyBuckets.length > 0 && <Sparkline buckets={data.weeklyBuckets} color={color} />}
      <Footer avgPerWeek={data.avgReleasesPerWeek} capped={data.totalReleaseCount >= FETCH_CAP} latestVersion={data.latestVersion} />
    </article>
  );
}

/* ---------- Header ---------- */

function Header({ name, cadence }: { name: string; cadence: { label: string; key: CadenceKey } }) {
  return (
    <div data-slot="cadence-card-header" className="flex justify-between items-start mb-3">
      <div data-slot="cadence-card-name" className="text-sm font-semibold text-stone-900">
        {name}
      </div>
      <Badge cadence={cadence.key} label={cadence.label} />
    </div>
  );
}

/* ---------- Badge ---------- */

const badgeStyles: Record<CadenceKey, string> = {
  daily: "bg-green-50 text-green-600",
  weekly: "bg-blue-50 text-blue-600",
  biweekly: "bg-purple-50 text-purple-600",
  monthly: "bg-amber-50 text-amber-600",
  sparse: "bg-stone-100 text-stone-400",
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
      <div data-slot="cadence-stat-label" className="text-[11px] text-stone-500 mb-3">
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
              className="flex-1 rounded-sm min-h-px"
              style={{
                height: `${h}px`,
                backgroundColor: bucket.count > 0 ? color : "var(--color-stone-200)",
                alignSelf: "flex-end",
              }}
            />
            {bucket.count > 0 && (
              <HoverCard.Content className="bg-white border border-stone-200 rounded-lg shadow-lg px-3 py-2 min-w-[140px]">
                <div className="text-[11px] font-medium text-stone-500 mb-1">
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
  latestVersion,
}: {
  avgPerWeek: number;
  capped: boolean;
  latestVersion: string | null;
}) {
  return (
    <div
      data-slot="cadence-card-footer"
      className="flex justify-between mt-3 text-[11px] text-stone-500"
    >
      <span>{capped ? `${avgPerWeek.toFixed(1)}+` : avgPerWeek.toFixed(1)}/week avg</span>
      <span>{latestVersion ? `v${latestVersion}` : "\u2014"}</span>
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
