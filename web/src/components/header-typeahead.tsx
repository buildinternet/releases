"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  launcherAction,
  moveHighlight,
  resultsMatchQuery,
  typeaheadItems,
  type TypeaheadItem,
} from "@/lib/search-typeahead";
import { SEARCH_NATIVE_CANCEL_HIDDEN, SearchClearButton } from "./search-clear-button";
import { SearchTypeahead, TYPEAHEAD_LISTBOX_ID, useTypeaheadSearch } from "./search-typeahead";

/**
 * Header launcher: a single combobox that stays put while you type. Enter or
 * a result click navigates; keystrokes never do. Mounted by HeaderSearch on
 * every page except `/search`, where the page SearchBar is the only box.
 */
export function HeaderTypeahead({ className }: { className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isMac, setIsMac] = useState(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);

  const listOpen = open && query.trim().length > 0;
  const { results, loading } = useTypeaheadSearch(query, listOpen);
  const matchedResults = resultsMatchQuery(results, query) ? results : null;
  const items = typeaheadItems(matchedResults, query);

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const ua = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = ua.userAgentData?.platform ?? navigator.platform;
    setIsMac(/mac|iphone|ipad|ipod/i.test(platform));
  }, []);

  // Close the dropdown after a client navigation (result click / Enter) so a
  // leftover query in the still-mounted header box doesn't keep the list open.
  useEffect(() => {
    setOpen(false);
    setHighlight(null);
  }, [pathname]);

  useEffect(() => {
    if (!listOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setHighlight(null);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [listOpen]);

  function go(href: string) {
    setOpen(false);
    setHighlight(null);
    router.push(href);
  }

  function handleChange(next: string) {
    const result = launcherAction({ type: "change", query: next });
    if (result.kind === "go") {
      go(result.href);
      return;
    }
    setQuery(result.query);
    setOpen(result.query.trim().length > 0);
    setHighlight(null);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const result = launcherAction({
      type: "submit",
      query,
      highlight,
      items,
    });
    if (result.kind === "go") go(result.href);
  }

  function handleSelect(item: TypeaheadItem) {
    const result = launcherAction({ type: "select", item });
    if (result.kind === "go") go(result.href);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => moveHighlight(h, 1, items.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => moveHighlight(h, -1, items.length));
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setHighlight(null);
    }
  }

  const activeOptionId =
    listOpen && highlight != null ? `${TYPEAHEAD_LISTBOX_ID}-${highlight}` : undefined;

  return (
    <form onSubmit={handleSubmit} className={className}>
      <div ref={rootRef} className="relative">
        <SearchGlyph />
        <input
          ref={inputRef}
          name="q"
          type="search"
          role="combobox"
          aria-label="Search products and releases"
          aria-autocomplete="list"
          aria-expanded={listOpen}
          aria-controls={TYPEAHEAD_LISTBOX_ID}
          aria-activedescendant={activeOptionId}
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => {
            if (query.trim()) setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search products and releases..."
          autoComplete="off"
          spellCheck={false}
          className={`w-full truncate rounded-lg border border-stone-300 bg-white py-2.5 pl-9 pr-14 text-sm text-stone-900 placeholder:text-stone-400 outline-none transition-colors focus:border-stone-400 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:placeholder:text-stone-500 dark:focus:border-stone-500 ${SEARCH_NATIVE_CANCEL_HIDDEN}`}
        />
        {query.length > 0 ? (
          <SearchClearButton
            onClear={() => {
              handleChange("");
              inputRef.current?.focus();
            }}
          />
        ) : (
          <kbd
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 right-2.5 hidden h-5 -translate-y-1/2 items-center gap-0.5 rounded border border-stone-200 bg-stone-50 px-1.5 font-sans text-[11px] font-medium text-stone-500 sm:inline-flex dark:border-stone-700 dark:bg-stone-800 dark:text-stone-400"
          >
            {isMac ? "⌘" : "Ctrl"}K
          </kbd>
        )}
        {listOpen && (
          <SearchTypeahead
            items={items}
            highlight={highlight}
            query={query}
            loading={loading}
            onHighlight={setHighlight}
            onSelect={handleSelect}
          />
        )}
      </div>
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
