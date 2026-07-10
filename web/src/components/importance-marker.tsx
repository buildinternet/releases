/**
 * Subtle importance cue for a release's AI-scored `importance` (1–5, scored
 * at ingest): a small flame glyph leading the title, NOT another chip — the
 * chip row is already dense (rollup, breaking, cluster, pre) and the feed
 * reads better when importance is a quiet priority marker.
 *
 * Renders NOTHING below 4 — most releases score 1–3 (housekeeping/routine/
 * notable) and a marker on every row would be noise; only 4 ("major",
 * company-significant) and 5 ("landmark", industry-notable) earn the flame.
 * Level is encoded in one glyph slot: outline amber at 4, solid orange at 5
 * (a second flame would double the width and read like a rating widget).
 * SVG only, no emoji, per the web UI convention (see PlayBadge). The
 * accessible label carries the meaning.
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

const FLAME_PATH =
  "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z";

export function ImportanceMarker({
  importance,
  className,
}: {
  importance?: number | null;
  className?: string;
}) {
  const label = importanceMarkerLabel(importance);
  if (!label) return null;
  const landmark = importance === 5;
  return (
    <span
      role="img"
      title={label}
      aria-label={label}
      className={`inline-flex shrink-0 self-center ${
        landmark ? "text-orange-500 dark:text-orange-400" : "text-amber-500 dark:text-amber-400"
      } ${className ?? ""}`}
    >
      <svg
        className="h-3 w-3"
        viewBox="0 0 24 24"
        fill={landmark ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={landmark ? 1.5 : 2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={FLAME_PATH} />
      </svg>
    </span>
  );
}
