"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useDebounced } from "@/hooks/use-debounced";
import type { UnifiedSearchResponse } from "@/lib/api";
import { DEFAULT_RANGE, rangeSince, type SearchRangeKey } from "@/lib/search-range";

type SearchContextValue = {
  /** Live input text — the single source of truth for every search input. */
  query: string;
  /** Update the query: re-renders the inputs and (debounced) refreshes results. */
  setQuery: (value: string) => void;
  /**
   * The debounced query the current `results` correspond to. Used for result
   * highlighting and the CLI hint so they track the fetched results rather than
   * flickering on every keystroke.
   */
  committedQuery: string;
  /** Latest results, or `null` for the empty state. */
  results: UnifiedSearchResponse | null;
  /** Active timeframe filter key. */
  range: SearchRangeKey;
  /** Change the timeframe filter; re-runs the search immediately. */
  setRange: (value: SearchRangeKey) => void;
};

const SearchContext = createContext<SearchContextValue | null>(null);

/**
 * Access the shared search state. Returns `null` outside a {@link SearchProvider}
 * (e.g. the header on a non-search page). The header mounts HeaderTypeahead
 * there; SearchBar on `/search` is the only consumer of this hook.
 */
export function useSearch(): SearchContextValue | null {
  return useContext(SearchContext);
}

const DEBOUNCE_MS = 200;

function syncUrl(value: string, range: SearchRangeKey): void {
  const trimmed = value.trim();
  const params = new URLSearchParams();
  if (trimmed) params.set("q", trimmed);
  // Omit the default so the common past-year case keeps a clean URL; any other
  // window (incl. "any") is written explicitly so deep links restore it.
  if (range !== DEFAULT_RANGE) params.set("range", range);
  // The active tab is owned by SearchResults (`?filter=`); carry it over so a
  // query keystroke doesn't wipe the tab out of the URL.
  const filter = new URLSearchParams(window.location.search).get("filter");
  if (filter) params.set("filter", filter);
  const qs = params.toString();
  const url = qs ? `/search?${qs}` : "/search";
  // Shallow URL update: keeps `/search?q=&range=` shareable and the
  // back/forward URL honest WITHOUT a Next navigation or RSC fetch. Preserving
  // the existing history state object keeps the App Router's own router state
  // intact.
  window.history.replaceState(window.history.state, "", url);
}

export function SearchProvider({
  initialQuery,
  initialResults,
  initialRange,
  children,
}: {
  initialQuery: string;
  initialResults: UnifiedSearchResponse | null;
  initialRange: SearchRangeKey;
  children: React.ReactNode;
}) {
  const [query, setQueryState] = useState(initialQuery);
  const [results, setResults] = useState<UnifiedSearchResponse | null>(initialResults);
  const [range, setRangeState] = useState<SearchRangeKey>(initialRange);
  const debouncedQuery = useDebounced(query, DEBOUNCE_MS);

  const abortRef = useRef<AbortController | null>(null);
  const seededRef = useRef(false);

  const runSearch = useCallback((value: string, since?: string) => {
    // Abort any in-flight request so a slow earlier query can never overwrite
    // the results for a newer one — this is what makes fast typing converge on
    // the latest query instead of freezing on a stale one.
    abortRef.current?.abort();

    const trimmed = value.trim();
    if (!trimmed) {
      abortRef.current = null;
      setResults(null);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    const sinceParam = since ? `&since=${encodeURIComponent(since)}` : "";
    fetch(`/api/search?q=${encodeURIComponent(trimmed)}&limit=20${sinceParam}`, {
      signal: controller.signal,
    })
      .then((res) => (res.ok ? (res.json() as Promise<UnifiedSearchResponse>) : null))
      .then((data) => {
        if (!controller.signal.aborted) setResults(data);
      })
      .catch((err: unknown) => {
        if ((err as Error).name === "AbortError") return;
      });
  }, []);

  const setQuery = useCallback((value: string) => setQueryState(value), []);
  const setRange = useCallback((value: SearchRangeKey) => setRangeState(value), []);

  // React to the (debounced) query: refresh results and sync the URL. The first
  // run is the mount seed — when the server already rendered results for the
  // initial query (deep link / hard load / Enter from the header typeahead) we
  // skip the fetch and the redundant URL write; empty cases fall through.
  useEffect(() => {
    if (!seededRef.current) {
      seededRef.current = true;
      if (initialResults !== null) return;
    }
    runSearch(debouncedQuery, rangeSince(range));
    syncUrl(debouncedQuery, range);
  }, [debouncedQuery, range, initialResults, runSearch]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <SearchContext.Provider
      value={{ query, setQuery, committedQuery: debouncedQuery, results, range, setRange }}
    >
      {children}
    </SearchContext.Provider>
  );
}
