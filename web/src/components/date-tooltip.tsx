"use client";

import { HoverCard } from "@/components/hover-card";
import { formatRelativeDate } from "@/lib/formatters";

export function AbsoluteDateTooltip({ iso }: { iso: string | null }) {
  if (!iso) return <span>{"\u2014"}</span>;

  const formatted = new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <HoverCard.Root>
      <HoverCard.Trigger className="inline">
        <span>{formatRelativeDate(iso)}</span>
      </HoverCard.Trigger>
      <HoverCard.Content side="top" align="end" sideOffset={4}>
        <div className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-lg shadow-lg px-3 py-1.5 text-[11px] text-stone-600 dark:text-stone-300 font-mono tabular-nums whitespace-nowrap">
          {formatted}
        </div>
      </HoverCard.Content>
    </HoverCard.Root>
  );
}
