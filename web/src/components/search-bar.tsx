"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const MOBILE_QUERY = "(max-width: 640px)";

export function SearchBar({
  defaultValue,
  className,
  sourceCount,
  autoFocus = true,
}: {
  defaultValue?: string;
  className?: string;
  sourceCount?: number;
  autoFocus?: boolean;
}) {
  const router = useRouter();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    if (typeof navigator !== "undefined") {
      setIsMac(/Mac|iPhone|iPad|iPod/.test(navigator.platform));
    }
  }, []);

  useEffect(() => {
    if (!autoFocus) return;
    const mql = window.matchMedia(MOBILE_QUERY);
    if (!mql.matches) {
      inputRef.current?.focus();
    }
  }, [autoFocus]);

  function updateUrl(value: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      const url = value.trim() ? `/search?q=${encodeURIComponent(value.trim())}` : "/search";
      router.replace(url, { scroll: false });
    }, 300);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const input = e.currentTarget.elements.namedItem("q") as HTMLInputElement;
    const value = input.value.trim();
    const url = value ? `/search?q=${encodeURIComponent(value)}` : "/search";
    router.replace(url, { scroll: false });
  }

  const placeholder = sourceCount
    ? `Search ${sourceCount.toLocaleString()} sources — "react", "vercel cli", "postgres 16"...`
    : `Search organizations, products, and releases...`;

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
          type="text"
          defaultValue={defaultValue}
          onChange={(e) => updateUrl(e.target.value)}
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
