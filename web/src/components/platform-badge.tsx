interface PlatformBadgeProps {
  label: string;
}

/**
 * Small labelled chip marking an app source's platform ("iOS" / "macOS").
 * Labelled text only — no emoji or arrow glyphs (house style). Styling mirrors
 * the existing source-card badges.
 */
export function PlatformBadge({ label }: PlatformBadgeProps) {
  return (
    <span className="text-[10px] font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400 bg-stone-100 dark:bg-stone-800 px-1.5 py-0.5 rounded shrink-0">
      {label}
    </span>
  );
}
