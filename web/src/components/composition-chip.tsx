import type { ReleaseComposition } from "@buildinternet/releases-api-types";

/**
 * Small inline chip summarizing a release's composition by category, e.g.
 * "12 fixes · 3 features · 1 enhancement". Renders nothing when composition
 * is null/undefined or all-zero. Segments with a zero count are dropped so
 * a bugfix-only release reads as just "12 fixes".
 */
export function CompositionChip({
  composition,
  className,
}: {
  composition: ReleaseComposition | null | undefined;
  className?: string;
}) {
  if (!composition) return null;
  const segments: string[] = [];
  if (composition.bugs > 0) segments.push(plural(composition.bugs, "fix", "fixes"));
  if (composition.features > 0) segments.push(plural(composition.features, "feature", "features"));
  if (composition.enhancements > 0)
    segments.push(plural(composition.enhancements, "enhancement", "enhancements"));
  if (segments.length === 0) return null;
  return (
    <span
      title="AI-tallied counts of distinct items in the release notes"
      className={`inline-flex items-center rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-[11px] font-medium text-stone-500 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-400 ${className ?? ""}`}
    >
      {segments.join(" · ")}
    </span>
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
