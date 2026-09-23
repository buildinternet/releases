"use client";

import {
  FilterMenuCheckbox,
  FilterMenuRadio,
  FilterMenuSection,
  FilterMenuSeparator,
  FiltersPopover,
} from "@/components/filters-popover";
import { SEARCH_NATIVE_CANCEL_HIDDEN, SearchClearButton } from "./search-clear-button";

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
 * Filter-releases text input with an attached filters popover, rendered as a
 * single grouped control. Shared by {@link SourceReleaseList} and
 * {@link OrgReleaseList}.
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
  const showTimeRange = typeof onSinceChange === "function";
  const hasActiveFilter = includePrereleases || (showTimeRange && !!since);

  return (
    <div className={className}>
      <div className="flex items-stretch rounded-md border border-stone-200 bg-white transition-colors focus-within:border-stone-300 dark:border-stone-700 dark:bg-stone-900 dark:focus-within:border-stone-600">
        <div className="relative min-w-0 flex-1">
          <input
            type="search"
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder={placeholder}
            aria-label="Filter releases"
            className={`min-w-0 w-full rounded-md bg-transparent py-1 pl-2 pr-7 text-[12px] text-stone-700 placeholder:text-stone-400 focus:outline-none dark:text-stone-200 dark:placeholder:text-stone-500 ${SEARCH_NATIVE_CANCEL_HIDDEN}`}
          />
          {value.length > 0 && (
            <SearchClearButton
              onClear={() => onValueChange("")}
              className="right-0.5 rounded p-0.5 [&_svg]:h-3.5 [&_svg]:w-3.5"
            />
          )}
        </div>
        <FiltersPopover
          active={hasActiveFilter}
          triggerClassName="border-l border-stone-200 px-2 dark:border-stone-700"
        >
          {showTimeRange && (
            <>
              <FilterMenuSection label="Time range">
                <div role="group" aria-label="Time range">
                  {TIME_RANGES.map((opt) => (
                    <FilterMenuRadio
                      key={opt.value || "all"}
                      checked={(since ?? "") === opt.value}
                      onSelect={() => onSinceChange?.(opt.value)}
                    >
                      {opt.label}
                    </FilterMenuRadio>
                  ))}
                </div>
              </FilterMenuSection>
              <FilterMenuSeparator />
            </>
          )}
          <FilterMenuCheckbox checked={includePrereleases} onChange={onIncludePrereleasesChange}>
            Show prereleases
          </FilterMenuCheckbox>
        </FiltersPopover>
      </div>
    </div>
  );
}
