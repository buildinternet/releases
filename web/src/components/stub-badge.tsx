import type { OrgStatus } from "@buildinternet/releases-api-types";

/**
 * Icon-only marker for a stub-tier org (#1947 self-serve listing lane) — a
 * self-declared directory entry (posted a `releases.json`) with no processed
 * sources yet. Deliberately just an icon: "stub" is internal jargon, so the
 * meaning rides the tooltip/aria-label, not visible text. Pair it with the
 * origin domain (rendered by the caller) — the domain is the trustworthy
 * anchor, since a self-declared *name* can claim any identity but the listing
 * only proves control of the domain that served the manifest.
 */
export function StubBadge({ status, className }: { status?: OrgStatus; className?: string }) {
  if (status !== "stub") return null;
  const label = "Self-listed via releases.json — not yet tracked";
  return (
    <span
      title={label}
      aria-label={label}
      role="img"
      className={`inline-flex shrink-0 text-stone-400 dark:text-stone-500 ${className ?? ""}`}
    >
      <svg
        viewBox="0 0 24 24"
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <line x1="12" y1="11" x2="12" y2="16.5" strokeLinecap="round" />
        <circle cx="12" cy="7.75" r="0.6" fill="currentColor" stroke="none" />
      </svg>
    </span>
  );
}
