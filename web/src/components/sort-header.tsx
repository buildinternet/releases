"use client";

import type { ReactNode } from "react";

export type SortDir = "asc" | "desc";

export interface SortState<F extends string> {
  field: F;
  dir: SortDir;
}

interface Props<F extends string> {
  field: F;
  current: SortState<F>;
  /** Direction applied when this column is first clicked. Defaults to "asc". */
  defaultDir?: SortDir;
  onChange: (next: SortState<F>) => void;
  className?: string;
  /** Renders to the right of the arrow (e.g. right-aligned numeric columns). */
  alignRight?: boolean;
  children: ReactNode;
}

export function SortHeader<F extends string>({
  field,
  current,
  defaultDir = "asc",
  onChange,
  className,
  alignRight,
  children,
}: Props<F>) {
  const active = current.field === field;
  const arrow = active ? (current.dir === "asc" ? "▲" : "▼") : "↕";

  const handleClick = () => {
    if (!active) {
      onChange({ field, dir: defaultDir });
    } else {
      onChange({ field, dir: current.dir === "asc" ? "desc" : "asc" });
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-stone-700 dark:hover:text-stone-200 ${
        active ? "text-stone-700 dark:text-stone-200" : "text-stone-400 dark:text-stone-500"
      } ${alignRight ? "ml-auto" : ""} ${className ?? ""}`}
    >
      <span>{children}</span>
      <span aria-hidden className={`text-[9px] ${active ? "opacity-100" : "opacity-30"}`}>
        {arrow}
      </span>
    </button>
  );
}
