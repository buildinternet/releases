"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useDebounced } from "@/hooks/use-debounced";
import type { UnifiedSearchResponse } from "@/lib/api";
import { DEFAULT_RANGE, rangeSince } from "@/lib/search-range";
import type { TypeaheadItem } from "@/lib/search-typeahead";
import { Highlight, tokenizeQuery } from "./highlight";

const DEBOUNCE_MS = 200;
export const TYPEAHEAD_LISTBOX_ID = "header-search-listbox";

const KIND_LABEL: Record<Exclude<TypeaheadItem["kind"], "search">, string> = {
  org: "Org",
  product: "Product",
  collection: "Collection",
  release: "Release",
};

/**
 * Live `/api/search` for the header typeahead. Same debounce + abort pattern
 * as SearchProvider, scoped to the launcher so the search page stays the
 * owner of full results.
 */
export function useTypeaheadSearch(query: string, enabled: boolean): UnifiedSearchResponse | null {
  const debouncedQuery = useDebounced(query, DEBOUNCE_MS);
  const [results, setResults] = useState<UnifiedSearchResponse | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled) return;

    abortRef.current?.abort();
    const trimmed = debouncedQuery.trim();
    if (!trimmed) {
      abortRef.current = null;
      setResults(null);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    const since = rangeSince(DEFAULT_RANGE);
    const sinceParam = since ? `&since=${encodeURIComponent(since)}` : "";
    fetch(`/api/search?q=${encodeURIComponent(trimmed)}&limit=10${sinceParam}`, {
      signal: controller.signal,
    })
      .then((res) => (res.ok ? (res.json() as Promise<UnifiedSearchResponse>) : null))
      .then((data) => {
        if (!controller.signal.aborted) setResults(data);
      })
      .catch((err: unknown) => {
        if ((err as Error).name === "AbortError") return;
      });

    return () => controller.abort();
  }, [debouncedQuery, enabled]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return results;
}

export function SearchTypeahead({
  items,
  highlight,
  query,
  onHighlight,
  onSelect,
}: {
  items: TypeaheadItem[];
  highlight: number | null;
  query: string;
  onHighlight: (index: number) => void;
  onSelect: (item: TypeaheadItem) => void;
}) {
  const tokens = tokenizeQuery(query);
  if (items.length === 0) return null;

  return (
    <div
      id={TYPEAHEAD_LISTBOX_ID}
      role="listbox"
      aria-label="Search suggestions"
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
      </ul>
    </div>
  );
}
