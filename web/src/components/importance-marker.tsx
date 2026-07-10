/**
 * Subtle importance cue for a release's AI-scored `importance` (1–5, scored
 * at ingest): a small colored dot leading the title, NOT another chip — the
 * chip row is already dense (rollup, breaking, cluster, pre) and the feed
 * reads better when importance is a quiet priority marker.
 *
 * Renders NOTHING below 4 — most releases score 1–3 (housekeeping/routine/
 * notable) and a marker on every row would be noise; only 4 ("major",
 * company-significant) and 5 ("landmark", industry-notable) earn the dot.
 * Amber for 4, orange for 5. Accessible label carries the meaning.
 */

/**
 * Score → accessible label. Pure so the visibility/label mapping is testable
 * without a DOM harness. Returns null when no marker should render.
 */
export function importanceMarkerLabel(importance: number | null | undefined): string | null {
  if (importance === 5) return "Importance 5/5 — landmark, significant beyond this vendor";
  if (importance === 4) return "Importance 4/5 — major for this company";
  return null;
}

export function ImportanceMarker({
  importance,
  className,
}: {
  importance?: number | null;
  className?: string;
}) {
  const label = importanceMarkerLabel(importance);
  if (!label) return null;
  const colorClasses =
    importance === 5 ? "bg-orange-500 dark:bg-orange-400" : "bg-amber-400 dark:bg-amber-500";
  return (
    <span
      role="img"
      title={label}
      aria-label={label}
      className={`inline-block h-1.5 w-1.5 shrink-0 self-center rounded-full ${colorClasses} ${className ?? ""}`}
    />
  );
}
