import { HoverCard } from "@/components/hover-card";
import { type CadenceKey, type WeeklyBucket, DAY_MS, fmtWeek, getCadenceInfo } from "@/lib/cadence";

const badgeStyles: Record<CadenceKey, string> = {
  daily: "bg-green-50 dark:bg-green-950 text-green-600 dark:text-green-400",
  weekly: "bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400",
  biweekly: "bg-purple-50 dark:bg-purple-950 text-purple-600 dark:text-purple-400",
  monthly: "bg-amber-50 dark:bg-amber-950 text-amber-600 dark:text-amber-400",
  sparse: "bg-stone-100 dark:bg-stone-800 text-stone-400",
};

export function CadenceBadge({ avgPerWeek }: { avgPerWeek: number }) {
  const cadenceInfo = getCadenceInfo(avgPerWeek);
  return (
    <span
      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide ${badgeStyles[cadenceInfo.key]}`}
    >
      {cadenceInfo.label}
    </span>
  );
}

export function InlineSparkline({ buckets, color }: { buckets: WeeklyBucket[]; color: string }) {
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
