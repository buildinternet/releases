"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FilterMenuRadio, FilterMenuSection, FiltersPopover } from "@/components/filters-popover";
import { DEFAULT_RANGE, SEARCH_RANGES } from "@/lib/search-range";
import { setPendingQuery, useSearch } from "./search-provider";

const MOBILE_QUERY = "(max-width: 640px)";

export function SearchBar({
  className,
  sourceCount,
  autoFocus = true,
  withFilters = false,
}: {
  className?: string;
  sourceCount?: number;
  autoFocus?: boolean;
  /** Attach a timeframe filter popover. Only meaningful inside SearchProvider. */
  withFilters?: boolean;
}) {
  const search = useSearch();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isMac, setIsMac] = useState(false);

  // Launcher mode (no provider — e.g. the header on a non-search page): hold the
  // text locally so the box shows everything typed, stash it for the handoff,
  // and route to /search on the first keystroke. The provider then adopts the
  // latest stashed text on mount, so nothing is lost across the navigation.
  const [launchValue, setLaunchValue] = useState("");
  const navigatedRef = useRef(false);

  const value = search ? search.query : launchValue;
  const showFilters = withFilters && search != null;
  const filterActive = showFilters && search.range !== DEFAULT_RANGE;

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const ua = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = ua.userAgentData?.platform ?? navigator.platform;
    setIsMac(/mac|iphone|ipad|ipod/i.test(platform));
  }, []);

  useEffect(() => {
    if (!autoFocus) return;
    const mql = window.matchMedia(MOBILE_QUERY);
    if (!mql.matches) {
      const input = inputRef.current;
      if (input) {
        input.focus();
        // Place the caret after any seeded text instead of selecting it, so
        // continuing to type appends rather than replaces.
        const end = input.value.length;
        input.setSelectionRange(end, end);
      }
    }
  }, [autoFocus]);

  function handleChange(next: string) {
    if (search) {
      search.setQuery(next);
      return;
    }
    setLaunchValue(next);
    setPendingQuery(next);
    if (!navigatedRef.current) {
      navigatedRef.current = true;
      router.push("/search");
    }
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (search) {
      // Already live on the search page — Enter just keeps the current results.
      return;
    }
    setPendingQuery(launchValue);
    router.push("/search");
  }

  const placeholder = sourceCount
    ? `Search ${sourceCount.toLocaleString()} sources — "react", "vercel cli", "postgres 16"...`
    : `Search products and releases...`;

  const input = (
    <input
      ref={inputRef}
      name="q"
      type="search"
      role="searchbox"
      aria-label="Search products and releases"
      value={value}
      onChange={(e) => handleChange(e.target.value)}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      className={
        showFilters
          ? "min-w-0 flex-1 truncate bg-transparent py-2.5 pl-9 pr-2 text-sm text-stone-900 placeholder:text-stone-400 outline-none dark:text-stone-100 dark:placeholder:text-stone-500"
          : "w-full truncate rounded-lg border border-stone-300 bg-white py-2.5 pl-9 pr-14 text-sm text-stone-900 placeholder:text-stone-400 outline-none transition-colors focus:border-stone-400 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:placeholder:text-stone-500 dark:focus:border-stone-500"
      }
    />
  );

  return (
    <form onSubmit={handleSubmit} className={className}>
      {showFilters ? (
        <div className="flex items-stretch rounded-lg border border-stone-300 bg-white transition-colors focus-within:border-stone-400 dark:border-stone-700 dark:bg-stone-900 dark:focus-within:border-stone-500">
          <div className="relative min-w-0 flex-1">
            <SearchGlyph />
            {input}
          </div>
          <FiltersPopover
            active={filterActive}
            triggerClassName="border-l border-stone-300 px-2.5 dark:border-stone-700"
          >
            <FilterMenuSection label="Time range">
              <div role="group" aria-label="Time range">
                {SEARCH_RANGES.map((r) => (
                  <FilterMenuRadio
                    key={r.key}
                    checked={search.range === r.key}
                    onSelect={() => search.setRange(r.key)}
                  >
                    {r.label}
                  </FilterMenuRadio>
                ))}
              </div>
            </FilterMenuSection>
          </FiltersPopover>
        </div>
      ) : (
        <div className="relative">
          <SearchGlyph />
          {input}
          <kbd
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 right-2.5 hidden h-5 -translate-y-1/2 items-center gap-0.5 rounded border border-stone-200 bg-stone-50 px-1.5 font-sans text-[11px] font-medium text-stone-500 sm:inline-flex dark:border-stone-700 dark:bg-stone-800 dark:text-stone-400"
          >
            {isMac ? "⌘" : "Ctrl"}K
          </kbd>
        </div>
      )}
    </form>
  );
}

function SearchGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-stone-400 dark:text-stone-500"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
