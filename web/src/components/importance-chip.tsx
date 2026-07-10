/**
 * Small text chip surfacing a release's AI-scored `importance` (1–5, scored
 * at ingest). Rendered on list cards and the detail header next to the other
 * title metadata, styled after BreakingChip/ClusterChip.
 *
 * Renders NOTHING below 4 — most releases score 1–3 (housekeeping/routine/
 * notable) and a chip on every row would be noise on the feed; only 4
 * ("major", company-significant) and 5 ("landmark", industry-notable) earn a
 * chip. Text only: no emojis, no glyph icons.
 */

/**
 * Score → chip label. Pure so the visibility/label mapping is testable
 * without a DOM harness. Returns null when no chip should render.
 */
export function importanceChipLabel(importance: number | null | undefined): string | null {
  if (importance === 5) return "Landmark";
  if (importance === 4) return "Major";
  return null;
}

export function ImportanceChip({
  importance,
  className,
}: {
  importance?: number | null;
  className?: string;
}) {
  const label = importanceChipLabel(importance);
  if (!label) return null;
  const title =
    importance === 5
      ? "Importance 5/5 — landmark, significant beyond this vendor"
      : "Importance 4/5 — major for this company";
  const colorClasses =
    importance === 5
      ? "border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-700/60 dark:bg-orange-950/40 dark:text-orange-400"
      : "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-400";
  return (
    <span
      title={title}
      aria-label={title}
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${colorClasses} ${className ?? ""}`}
    >
      {label}
    </span>
  );
}
