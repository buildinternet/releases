"use client";

import type { ReactNode } from "react";
import { Caret } from "@/components/caret";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Shared "filters" affordance: a trigger (funnel + caret + optional active
 * dot) that opens a Base UI popover. Used by the search bar, the org/source
 * release filter, and the collection timeline — do not add another
 * pointerdown+Escape menu for this pattern.
 */
export function FiltersPopover({
  active = false,
  align = "end",
  children,
  label = "Filters",
  triggerClassName,
}: {
  active?: boolean;
  align?: "start" | "center" | "end";
  children: ReactNode;
  label?: string;
  triggerClassName?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        title={label}
        className={cn(
          "group/filters relative inline-flex items-center gap-1 text-stone-500 transition-colors hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200",
          triggerClassName,
        )}
      >
        <FilterIcon />
        {active && (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-stone-500 dark:bg-stone-300"
          />
        )}
        <span className="transition-transform group-data-popup-open/filters:rotate-90">
          <Caret open={false} />
        </span>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-48 gap-0 rounded-md p-1">
        {children}
      </PopoverContent>
    </Popover>
  );
}

export function FilterMenuSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500">
        {label}
      </div>
      {children}
    </div>
  );
}

export function FilterMenuRadio({
  checked,
  onSelect,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      onClick={onSelect}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-stone-600 hover:bg-stone-50 dark:text-stone-300 dark:hover:bg-stone-800"
    >
      <span>{children}</span>
      {checked && <CheckMark className="ml-auto text-stone-500 dark:text-stone-300" />}
    </button>
  );
}

export function FilterMenuCheckbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2 px-3 py-1.5 text-[12px] text-stone-600 hover:bg-stone-50 dark:text-stone-300 dark:hover:bg-stone-800">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-stone-700 dark:accent-stone-300"
      />
      <span>{children}</span>
    </label>
  );
}

export function FilterMenuSeparator() {
  return <div className="my-1 border-t border-stone-100 dark:border-stone-800" />;
}

function FilterIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="flex-none"
    >
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  );
}

function CheckMark({ className }: { className?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`flex-none ${className ?? ""}`}
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
