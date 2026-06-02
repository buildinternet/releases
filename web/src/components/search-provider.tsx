"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useDebounced } from "@/hooks/use-debounced";
import type { UnifiedSearchResponse } from "@/lib/api";

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
};

const SearchContext = createContext<SearchContextValue | null>(null);

/**
 * Access the shared search state. Returns `null` outside a {@link SearchProvider}
 * (e.g. the header bar on a non-search page), which the search box reads as
 * "launcher mode" — see `search-bar.tsx`.
 */
export function useSearch(): SearchContextValue | null {
  return useContext(SearchContext);
}

const DEBOUNCE_MS = 200;

/**
 * Cross-navigation handoff for the header search box. When the user starts
 * typing in the header on a non-search page we stash the in-progress text here
 * and route to `/search`. A module-level variable (not React state) survives
 * the client-side route change AND the unmount of the source input, so the
 * provider can pick up the latest text on mount — no characters are lost in the
 * handoff, and we never have to block the navigation on a server search fetch.
 *
 * Only ever written from a browser event handler, so on the server it stays
 * `null` and can't leak across SSR requests. Peek and clear are split so the
 * value can be read in a `useState` initializer (which React may invoke twice
 * under Strict Mode) without being consumed before the mount effect.
 */
let pendingQuery: string | null = null;

export function setPendingQuery(value: string): void {
  pendingQuery = value;
}

function peekPendingQuery(): string | null {
  return pendingQuery;
}

function clearPendingQuery(): void {
  pendingQuery = null;
}

function syncUrl(value: string): void {
  const trimmed = value.trim();
  const url = trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : "/search";
  // Shallow URL update: keeps `/search?q=` shareable and the back/forward URL
  // honest WITHOUT a Next navigation or RSC fetch. Preserving the existing
  // history state object keeps the App Router's own router state intact.
  window.history.replaceState(window.history.state, "", url);
}

export function SearchProvider({
  initialQuery,
  initialResults,
  children,
}: {
  initialQuery: string;
  initialResults: UnifiedSearchResponse | null;
  children: React.ReactNode;
}) {
  // Seed from the cross-page handoff when present (header launcher → /search),
  // otherwise from the server-provided query (deep link / hard load).
  const [query, setQueryState] = useState(() => peekPendingQuery() ?? initialQuery);
  const [results, setResults] = useState<UnifiedSearchResponse | null>(initialResults);
  const debouncedQuery = useDebounced(query, DEBOUNCE_MS);

  const abortRef = useRef<AbortController | null>(null);
  const seededRef = useRef(false);

  const runSearch = useCallback((value: string) => {
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

    fetch(`/api/search?q=${encodeURIComponent(trimmed)}&limit=20`, {
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

  // React to the (debounced) query: refresh results and sync the URL. The first
  // run is the mount seed — when the server already rendered results for the
  // initial query (deep link / hard load) we skip the fetch and the redundant
  // URL write; the handoff and empty cases fall through to fetch + sync.
  useEffect(() => {
    if (!seededRef.current) {
      seededRef.current = true;
      const wasHandoff = peekPendingQuery() !== null;
      clearPendingQuery();
      if (initialResults !== null && !wasHandoff) return;
    }
    runSearch(debouncedQuery);
    syncUrl(debouncedQuery);
  }, [debouncedQuery, initialResults, runSearch]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <SearchContext.Provider value={{ query, setQuery, committedQuery: debouncedQuery, results }}>
      {children}
    </SearchContext.Provider>
  );
}
