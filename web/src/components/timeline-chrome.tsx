"use client";

export type RangePreset = "all" | "90d" | "30d";

export function fmtCadence(avgPerWeek: number, avgPerMonth: number): string {
  return avgPerMonth >= 1 ? `${Math.round(avgPerMonth)}/mo` : `${Math.round(avgPerWeek)}/wk`;
}

export function highlightDaysForPreset(preset: RangePreset): number | null {
  return preset === "30d" ? 30 : preset === "90d" ? 90 : null;
}

export function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5" title={title}>
      <span className="text-[11px] uppercase tracking-wider text-stone-400 dark:text-stone-500">{label}</span>
      <span className="text-stone-700 dark:text-stone-200 font-medium tabular-nums">{value}</span>
    </span>
  );
}

const pillBase = "px-2.5 py-1 text-[11px] font-medium rounded transition-all";
const pillActive = "bg-white dark:bg-stone-700 text-stone-900 dark:text-stone-100 shadow-sm";
const pillInactive = "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300";

export function RangePills({
  value,
  onChange,
}: {
  value: RangePreset;
  onChange: (v: RangePreset) => void;
}) {
  const opts: Array<{ key: RangePreset; label: string }> = [
    { key: "all", label: "All" },
    { key: "90d", label: "90d" },
    { key: "30d", label: "30d" },
  ];
  return (
    <div className="inline-flex bg-stone-100 dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-md p-0.5">
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          className={`${pillBase} ${value === o.key ? pillActive : pillInactive}`}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
