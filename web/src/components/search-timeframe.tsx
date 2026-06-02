"use client";

import { SEARCH_RANGES, type SearchRangeKey } from "@/lib/search-range";
import { useSearch } from "./search-provider";

/**
 * Timeframe filter for the search page. Narrows release hits to a recent
 * window via the provider's `range` state (forwarded to `/v1/search` as
 * `since`). Renders nothing outside a {@link SearchProvider}.
 */
export function SearchTimeframe() {
  const search = useSearch();
  if (!search) return null;
  return (
    <select
      value={search.range}
      onChange={(e) => search.setRange(e.target.value as SearchRangeKey)}
      aria-label="Filter releases by timeframe"
      className="bg-transparent border border-stone-200 dark:border-stone-700 rounded px-2 py-1 text-xs text-stone-600 dark:text-stone-300 focus:outline-none focus:ring-1 focus:ring-stone-400"
    >
      {SEARCH_RANGES.map((r) => (
        <option key={r.key} value={r.key}>
          {r.label}
        </option>
      ))}
    </select>
  );
}
