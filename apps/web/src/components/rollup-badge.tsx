import type { ReleaseType } from "@buildinternet/releases-api-types";

export function RollupBadge({ type, className }: { type?: ReleaseType; className?: string }) {
  if (type !== "rollup") return null;
  return (
    <span
      title="Seasonal or quarterly catch-all post"
      className={`inline-flex items-center rounded-full border border-stone-200 bg-stone-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-stone-500 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-400 ${className ?? ""}`}
    >
      Rollup
    </span>
  );
}
