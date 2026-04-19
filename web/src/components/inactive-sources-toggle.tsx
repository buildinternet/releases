"use client";

import { useState } from "react";

export function InactiveSourcesToggle({
  count,
  children,
}: {
  count: number;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  if (count === 0) return null;

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-3 w-full text-xs text-stone-400 dark:text-stone-500 hover:text-stone-500 dark:hover:text-stone-400 transition-colors"
      >
        <div className="flex-1 h-px bg-stone-200 dark:bg-stone-800" />
        <span className="whitespace-nowrap flex items-center gap-1.5">
          <svg
            className={`w-3 h-3 transition-transform ${expanded ? "rotate-90" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          {count} inactive {count === 1 ? "source" : "sources"}
        </span>
        <div className="flex-1 h-px bg-stone-200 dark:bg-stone-800" />
      </button>
      {expanded && <div className="mt-3">{children}</div>}
    </div>
  );
}
