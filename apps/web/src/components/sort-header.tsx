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
  /** Right-align the label+arrow inside the grid cell (for numeric columns). */
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
      className={`flex items-center gap-1.5 p-0 uppercase tracking-wider transition-[color,transform] active:scale-[0.96] hover:text-stone-700 dark:hover:text-stone-200 ${
        active ? "text-stone-700 dark:text-stone-200" : "text-stone-400 dark:text-stone-500"
      } ${alignRight ? "justify-end" : ""} ${className ?? ""}`}
    >
      <span>{children}</span>
      <SortIndicator active={active} dir={current.dir} />
    </button>
  );
}

// Stacked up/down triangles, drawn as SVG so the glyphs don't get replaced
// with color emoji by the OS font stack. The inactive triangle on each row is
// rendered at low opacity to keep spacing identical across the three states.
function SortIndicator({ active, dir }: { active: boolean; dir: SortDir }) {
  const upActive = active && dir === "asc";
  const downActive = active && dir === "desc";
  const dim = "opacity-25";
  const lit = "opacity-100";
  return (
    <svg width="7" height="10" viewBox="0 0 7 10" aria-hidden className="shrink-0 fill-current">
      <path d="M3.5 0 L7 4 L0 4 Z" className={upActive ? lit : dim} />
      <path d="M3.5 10 L0 6 L7 6 Z" className={downActive ? lit : dim} />
    </svg>
  );
}
