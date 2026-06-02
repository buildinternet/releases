"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { setPendingQuery, useSearch } from "./search-provider";

const MOBILE_QUERY = "(max-width: 640px)";

export function SearchBar({
  className,
  sourceCount,
  autoFocus = true,
}: {
  className?: string;
  sourceCount?: number;
  autoFocus?: boolean;
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

  return (
    <form onSubmit={handleSubmit} className={className}>
      <div className="relative">
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400 dark:text-stone-500"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
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
          className="w-full bg-white dark:bg-stone-900 border border-stone-300 dark:border-stone-700 rounded-lg pl-9 pr-14 py-2.5 text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-500 outline-none focus:border-stone-400 dark:focus:border-stone-500 transition-colors truncate"
        />
        <kbd
          aria-hidden="true"
          className="hidden sm:inline-flex pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 items-center gap-0.5 rounded border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800 px-1.5 h-5 text-[11px] font-medium text-stone-500 dark:text-stone-400 font-sans"
        >
          {isMac ? "⌘" : "Ctrl"}K
        </kbd>
      </div>
    </form>
  );
}
