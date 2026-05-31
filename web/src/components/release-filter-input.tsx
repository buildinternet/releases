"use client";

import { useEffect, useRef, useState } from "react";
import { Caret } from "./caret";

interface ReleaseFilterInputProps {
  /** Live filter text (controlled). */
  value: string;
  onValueChange: (value: string) => void;
  /** Prerelease toggle, surfaced inside the attached filters dropdown. */
  includePrereleases: boolean;
  onIncludePrereleasesChange: (checked: boolean) => void;
  /**
   * Time-window value, as the relative shorthand the API accepts (`30d`, `3m`,
   * `1y`) — `""` means all time. Optional: pass `onSinceChange` to surface the
   * "Time range" group in the dropdown. Omit on surfaces whose feed API has no
   * `since` support (the per-source feed), where the group would be a no-op.
   */
  since?: string;
  onSinceChange?: (value: string) => void;
  placeholder?: string;
  className?: string;
}

/** Relative-window options forwarded as `?since=`; `""` clears the filter. */
const TIME_RANGES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "All time" },
  { value: "30d", label: "Past 30 days" },
  { value: "3m", label: "Past 3 months" },
  { value: "1y", label: "Past year" },
];

/**
 * Filter-releases text input with an attached "filters" dropdown, rendered as a
 * single grouped control. The dropdown holds the prerelease toggle and an
 * optional time-range group (and is the home for any future per-feed filters)
 * so they no longer need their own rows. Shared by {@link SourceReleaseList}
 * and {@link OrgReleaseList}.
 */
export function ReleaseFilterInput({
  value,
  onValueChange,
  includePrereleases,
  onIncludePrereleasesChange,
  since,
  onSinceChange,
  placeholder = "Filter releases…",
  className,
}: ReleaseFilterInputProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const showTimeRange = typeof onSinceChange === "function";
  const hasActiveFilter = includePrereleases || (showTimeRange && !!since);

  // Close on outside pointer / Escape — mirrors the OpenInAgentMenu dropdown.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} className={`relative ${className ?? ""}`}>
      <div className="flex items-stretch rounded-md border border-stone-200 bg-white transition-colors focus-within:border-stone-300 dark:border-stone-700 dark:bg-stone-900 dark:focus-within:border-stone-600">
        <input
          type="search"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder={placeholder}
          aria-label="Filter releases"
          className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-[12px] text-stone-700 placeholder:text-stone-400 focus:outline-none dark:text-stone-200 dark:placeholder:text-stone-500"
        />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="true"
          aria-expanded={open}
          aria-label="Release filters"
          title="Filters"
          className="relative flex items-center gap-1 border-l border-stone-200 px-2 text-stone-500 transition-colors hover:text-stone-700 dark:border-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
        >
          <FilterIcon />
          {hasActiveFilter && (
            <span
              aria-hidden="true"
              className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-stone-500 dark:bg-stone-300"
            />
          )}
          <Caret open={open} />
        </button>
      </div>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-48 overflow-hidden rounded-md border border-stone-200 bg-white py-1 shadow-lg dark:border-stone-800 dark:bg-stone-950"
        >
          {showTimeRange ? (
            <>
              <SectionHeader>Time range</SectionHeader>
              <div role="group" aria-label="Time range">
                {TIME_RANGES.map((opt) => {
                  const active = (since ?? "") === opt.value;
                  return (
                    <button
                      key={opt.value || "all"}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => onSinceChange?.(opt.value)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-stone-600 hover:bg-stone-50 dark:text-stone-300 dark:hover:bg-stone-800"
                    >
                      <span>{opt.label}</span>
                      {active && (
                        <CheckMark className="ml-auto text-stone-500 dark:text-stone-300" />
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="my-1 border-t border-stone-100 dark:border-stone-800" />
            </>
          ) : (
            <SectionHeader>Filters</SectionHeader>
          )}
          <label className="flex cursor-pointer select-none items-center gap-2 px-3 py-1.5 text-[12px] text-stone-600 hover:bg-stone-50 dark:text-stone-300 dark:hover:bg-stone-800">
            <input
              type="checkbox"
              checked={includePrereleases}
              onChange={(e) => onIncludePrereleasesChange(e.target.checked)}
              className="h-3.5 w-3.5 accent-stone-700 dark:accent-stone-300"
            />
            <span>Show prereleases</span>
          </label>
        </div>
      )}
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500">
      {children}
    </div>
  );
}

/** Decreasing-lines filter glyph — the conventional "filters" affordance. */
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
