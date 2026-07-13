import { DIGEST_BETA_NOTE } from "@/lib/copy";

/** Compact beta callout for digest index + detail pages. */
export function DigestBetaNote({ className = "" }: { className?: string }) {
  return (
    <p
      role="note"
      className={`rounded-lg border border-amber-200/80 bg-amber-50/80 px-3 py-2 text-[12.5px] leading-snug text-amber-900/80 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-100/80 ${className}`}
    >
      <span className="mr-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-700 dark:text-amber-300">
        Beta
      </span>
      {DIGEST_BETA_NOTE}
    </p>
  );
}
