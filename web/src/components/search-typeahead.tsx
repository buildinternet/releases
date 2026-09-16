"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useDebounced } from "@/hooks/use-debounced";
import type { UnifiedSearchResponse } from "@/lib/api";
import { DEFAULT_RANGE, rangeSince } from "@/lib/search-range";
import { KIND_LABEL, typeaheadStatus, type TypeaheadItem } from "@/lib/search-typeahead";
import { Highlight, tokenizeQuery } from "./highlight";

const DEBOUNCE_MS = 200;
export const TYPEAHEAD_LISTBOX_ID = "header-search-listbox";

/**
 * Live `/api/search` for the header typeahead. Same debounce + abort pattern
 * as SearchProvider, scoped to the launcher so the search page stays the
 * owner of full results.
 */
export function useTypeaheadSearch(
  query: string,
  enabled: boolean,
): { results: UnifiedSearchResponse | null; loading: boolean } {
  const debouncedQuery = useDebounced(query, DEBOUNCE_MS);
  const [results, setResults] = useState<UnifiedSearchResponse | null>(null);
  const [inflight, setInflight] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled) {
      setInflight(false);
      return;
    }

    abortRef.current?.abort();
    const trimmed = debouncedQuery.trim();
    if (!trimmed) {
      abortRef.current = null;
      setResults(null);
      setInflight(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setInflight(true);
    const since = rangeSince(DEFAULT_RANGE);
    const sinceParam = since ? `&since=${encodeURIComponent(since)}` : "";
    fetch(`/api/search?q=${encodeURIComponent(trimmed)}&limit=10${sinceParam}`, {
      signal: controller.signal,
    })
      .then((res) => (res.ok ? (res.json() as Promise<UnifiedSearchResponse>) : null))
      .then((data) => {
        if (!controller.signal.aborted) {
          setResults(data);
          setInflight(false);
        }
      })
      .catch((err: unknown) => {
        if ((err as Error).name === "AbortError") return;
        if (!controller.signal.aborted) setInflight(false);
      });

    return () => controller.abort();
  }, [debouncedQuery, enabled]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const trimmed = query.trim();
  const pendingDebounce = enabled && trimmed.length > 0 && trimmed !== debouncedQuery.trim();
  const loading = enabled && trimmed.length > 0 && (pendingDebounce || inflight);

  return { results, loading };
}

export function SearchTypeahead({
  items,
  highlight,
  query,
  loading,
  onHighlight,
  onSelect,
}: {
  items: TypeaheadItem[];
  highlight: number | null;
  query: string;
  loading: boolean;
  onHighlight: (index: number) => void;
  onSelect: (item: TypeaheadItem) => void;
}) {
  const tokens = tokenizeQuery(query);
  const status = typeaheadStatus({ query, loading, items });

  return (
    <div
      id={TYPEAHEAD_LISTBOX_ID}
      role="listbox"
      aria-label="Search suggestions"
      aria-busy={status === "loading"}
      className="absolute top-full right-0 left-0 z-50 mt-1 overflow-hidden rounded-lg border border-stone-200 bg-white shadow-lg dark:border-stone-700 dark:bg-stone-900"
    >
      <ul className="max-h-80 overflow-auto py-1">
        {items.map((item, index) => {
          const active = highlight === index;
          return (
            <li key={item.id}>
              <Link
                id={`${TYPEAHEAD_LISTBOX_ID}-${index}`}
                role="option"
                aria-selected={active}
                href={item.href}
                onMouseEnter={() => onHighlight(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.preventDefault();
                  onSelect(item);
                }}
                className={`flex items-center gap-3 px-3 py-2 text-sm ${
                  active
                    ? "bg-stone-100 text-stone-900 dark:bg-stone-800 dark:text-stone-100"
                    : "text-stone-800 dark:text-stone-200"
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {item.kind === "search" ? (
                      item.label
                    ) : (
                      <Highlight text={item.label} tokens={tokens} />
                    )}
                  </span>
                  {item.secondary && (
                    <span className="mt-0.5 block truncate text-xs text-stone-400 dark:text-stone-500">
                      <Highlight text={item.secondary} tokens={tokens} />
                    </span>
                  )}
                </span>
                {item.kind !== "search" && (
                  <span className="shrink-0 text-[10px] font-medium tracking-wide text-stone-400 uppercase dark:text-stone-500">
                    {KIND_LABEL[item.kind]}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
        {status === "loading" && (
          <li
            className="flex items-center gap-2 px-3 py-2 text-xs text-stone-400 dark:text-stone-500"
            role="status"
          >
            <Spinner className="h-3.5 w-3.5 animate-spin" />
            Searching…
          </li>
        )}
        {status === "empty" && (
          <li className="px-3 py-2 text-xs text-stone-400 dark:text-stone-500">
            No matching results
          </li>
        )}
      </ul>
    </div>
  );
}

function Spinner({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <path
        d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
