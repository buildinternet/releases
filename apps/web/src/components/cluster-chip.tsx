/**
 * Small badge surfaced on canonical releases that bundle one or more coverage
 * siblings via `release_coverage`. Rendered in list views so a reader can tell
 * at a glance that a row rolls up N peer packages instead of clicking through
 * to the detail page's <AlsoCoveredBy>.
 *
 * Renders nothing when count is 0 — a standalone release shouldn't show "+0".
 */
export function ClusterChip({ count, className }: { count?: number; className?: string }) {
  if (!count || count <= 0) return null;
  const label = count === 1 ? "1 related release" : `${count} related releases`;
  return (
    <span
      title={label}
      aria-label={label}
      className={`inline-flex items-center rounded-full border border-stone-200 bg-stone-50 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-stone-500 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-400 ${className ?? ""}`}
    >
      +{count}
    </span>
  );
}
