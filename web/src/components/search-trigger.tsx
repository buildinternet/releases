"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

function focusSearchInput() {
  document.querySelector<HTMLInputElement>('input[name="q"]')?.focus();
}

function TriggerChrome({ isMac }: { isMac: boolean }) {
  return (
    <>
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="h-4 w-4 text-stone-400 dark:text-stone-500"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <span>Search</span>
      <kbd
        aria-hidden="true"
        className="inline-flex h-5 items-center gap-0.5 rounded border border-stone-200 bg-stone-50 px-1.5 font-sans text-[11px] font-medium text-stone-500 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-400"
      >
        {isMac ? "⌘" : "Ctrl"}K
      </kbd>
    </>
  );
}

const triggerClass =
  "group items-center gap-2 rounded-lg border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 hover:border-stone-400 dark:hover:border-stone-500 px-2.5 h-9 text-sm text-stone-500 dark:text-stone-400 transition-colors";

export function SearchTrigger({ className }: { className?: string }) {
  const pathname = usePathname();
  const [isMac, setIsMac] = useState(false);
  const onSearchPage = pathname === "/search";

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const ua = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = ua.userAgentData?.platform ?? navigator.platform;
    setIsMac(/mac|iphone|ipad|ipod/i.test(platform));
  }, []);

  const classes = `${triggerClass} ${className ?? ""}`;

  // Already on /search: focus the page box instead of stacking a second input.
  if (onSearchPage) {
    return (
      <button type="button" aria-label="Search" onClick={focusSearchInput} className={classes}>
        <TriggerChrome isMac={isMac} />
      </button>
    );
  }

  return (
    <Link href="/search" aria-label="Search" className={classes}>
      <TriggerChrome isMac={isMac} />
    </Link>
  );
}
