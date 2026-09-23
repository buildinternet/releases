/**
 * Small text chip flagging a release's machine-classified breaking-change
 * level (`releases.breaking`, #1696/#1710). Rendered on list cards next to
 * the title metadata, styled after ClusterChip.
 *
 * Renders NOTHING for `none`, `unknown`, or an absent level — `unknown` is
 * the fail-open default on every unclassified/legacy row, so a chip there
 * would be noise on most of the feed. Text only: no emojis, no glyph icons.
 */

/**
 * Level → chip label. Pure so the visibility/label mapping is testable
 * without a DOM harness. Returns null when no chip should render.
 */
export function breakingChipLabel(level: string | null | undefined): string | null {
  if (level === "major") return "Breaking";
  if (level === "minor") return "Breaking (minor)";
  return null;
}

export function BreakingChip({ level, className }: { level?: string | null; className?: string }) {
  const label = breakingChipLabel(level);
  if (!label) return null;
  const title =
    level === "major"
      ? "Breaking change — removals, signature changes, or required migration"
      : "Minor breaking change — most consumers unaffected or trivial migration";
  return (
    <span
      title={title}
      aria-label={title}
      className={`inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-400 ${className ?? ""}`}
    >
      {label}
    </span>
  );
}
