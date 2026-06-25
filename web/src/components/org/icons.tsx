/**
 * Org-page line icons not covered by the shared account icon set
 * (`@/components/account/icons`). Stroke-based, inherit `currentColor`, sized
 * by `className`. Kept inline like the rest of the codebase's hand-rolled SVGs;
 * the shared `stroke` defaults avoid repeating them per icon.
 */
const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" strokeWidth={1.5} {...stroke} className={className} aria-hidden="true">
      <path d="M12 3.5l1.5 4.2L18 9l-4.5 1.3L12 14.5l-1.5-4.2L6 9l4.5-1.3z" />
      <path d="M18.6 14.2l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z" />
    </svg>
  );
}

export function LinkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" strokeWidth={1.6} {...stroke} className={className} aria-hidden="true">
      <path d="M10 13a4 4 0 0 0 5.7.3l2.5-2.5a4 4 0 0 0-5.7-5.7l-1.3 1.3" />
      <path d="M14 11a4 4 0 0 0-5.7-.3l-2.5 2.5a4 4 0 0 0 5.7 5.7l1.3-1.3" />
    </svg>
  );
}

export function MarkdownIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" strokeWidth={1.5} {...stroke} className={className} aria-hidden="true">
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M6.5 14.5V9.5l2.5 3 2.5-3v5" />
      <path d="M15.5 9.5v5M14 13l1.5 1.7 1.5-1.7" />
    </svg>
  );
}

export function ArrowRightIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" strokeWidth={1.8} {...stroke} className={className} aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" strokeWidth={1.7} {...stroke} className={className} aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function GlobeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" strokeWidth={1.5} {...stroke} className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" />
    </svg>
  );
}
