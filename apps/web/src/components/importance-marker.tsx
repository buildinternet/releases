"use client";

/**
 * Subtle importance cue for a release's AI-scored `importance` (1–5): a small
 * flame leading the title, not another chip. Renders nothing below 4; outline
 * amber at 4 ("major"), solid orange at 5 ("landmark"). SVG only (see PlayBadge).
 * Hover card + aria-label explain the score.
 */

import { HoverCard } from "@/components/hover-card";

export type ImportanceMarkerCopy = {
  label: string;
  description: string;
};

/** Score → copy. Pure for unit tests; null when no marker should render. */
export function importanceMarkerCopy(
  importance: number | null | undefined,
): ImportanceMarkerCopy | null {
  if (importance === 5) {
    return {
      label: "Landmark (5/5)",
      description:
        "AI-scored importance — significant beyond this vendor, not just this release train.",
    };
  }
  if (importance === 4) {
    return {
      label: "Major (4/5)",
      description: "AI-scored importance — a company-significant release.",
    };
  }
  return null;
}

/** Label only — prefer {@link importanceMarkerCopy} for full copy. */
export function importanceMarkerLabel(importance: number | null | undefined): string | null {
  return importanceMarkerCopy(importance)?.label ?? null;
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
  const copy = importanceMarkerCopy(importance);
  if (!copy) return null;

  const landmark = importance === 5;

  return (
    <HoverCard.Root>
      <HoverCard.Trigger
        role="img"
        aria-label={copy.label}
        className={`inline-flex shrink-0 cursor-help self-center ${
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
      </HoverCard.Trigger>
      <HoverCard.Content side="top" align="center" sideOffset={4}>
        <div className="max-w-[220px] rounded-lg border border-stone-200 bg-white px-3 py-2 shadow-lg dark:border-stone-700 dark:bg-stone-900">
          <div className="text-[11px] font-medium text-stone-700 dark:text-stone-200">
            {copy.label}
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-stone-500 dark:text-stone-400">
            {copy.description}
          </p>
        </div>
      </HoverCard.Content>
    </HoverCard.Root>
  );
}
