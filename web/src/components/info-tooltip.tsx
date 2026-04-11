"use client";

import { HoverCard } from "@/components/hover-card";

export function InfoTooltip({ text }: { text: string }) {
  return (
    <HoverCard.Root>
      <HoverCard.Trigger className="inline-flex items-center">
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          className="text-stone-300 dark:text-stone-600 hover:text-stone-400 dark:hover:text-stone-500 transition-colors cursor-help"
        >
          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 7v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="4.5" r="0.75" fill="currentColor" />
        </svg>
      </HoverCard.Trigger>
      <HoverCard.Content side="top" align="center" sideOffset={4}>
        <div className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-lg shadow-lg px-3 py-2 text-[11px] text-stone-500 dark:text-stone-400 max-w-[200px] leading-relaxed">
          {text}
        </div>
      </HoverCard.Content>
    </HoverCard.Root>
  );
}
