import type { OrgStatus } from "@buildinternet/releases-api-types";

/**
 * Quiet chip for a stub-tier org (#1947 self-serve listing lane) — a
 * directory entry with no processed sources yet, distinct from a
 * fully-tracked org. Styled like {@link RollupBadge}: subtle, not a
 * warning — this is directory breadth, not an error state.
 */
export function StubBadge({ status, className }: { status?: OrgStatus; className?: string }) {
  if (status !== "stub") return null;
  return (
    <span
      title="Listed but not yet actively tracked"
      className={`inline-flex items-center rounded-full border border-stone-200 bg-stone-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-stone-500 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-400 ${className ?? ""}`}
    >
      Not tracked
    </span>
  );
}
