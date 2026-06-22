"use client";

import { useEffect, useState } from "react";
import { useTheme } from "./theme-provider";

// Shared easing for the icon cross-fade; all three glyphs stay mounted and
// fade by opacity so cycling themes eases instead of hard-swapping (no motion
// lib installed). `iconWrap` centers each absolutely-stacked 16px glyph.
const ICON_FADE =
  "absolute inset-0 m-auto h-4 w-4 transition-opacity duration-150 ease-[cubic-bezier(0.2,0,0,1)]";

const SVG_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const displayTheme = mounted ? theme : "system";

  function cycle() {
    // light → dark → system → light
    if (theme === "light") setTheme("dark");
    else if (theme === "dark") setTheme("system");
    else setTheme("light");
  }

  return (
    <button
      type="button"
      onClick={cycle}
      className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-stone-400 transition-[color,background-color,transform] hover:bg-stone-100 hover:text-stone-600 active:scale-[0.96] dark:text-stone-500 dark:hover:bg-stone-800 dark:hover:text-stone-300"
      aria-label={`Theme: ${displayTheme}`}
      title={`Theme: ${displayTheme}`}
    >
      {/* light = sun */}
      <svg
        {...SVG_PROPS}
        className={`${ICON_FADE} ${displayTheme === "light" ? "opacity-100" : "opacity-0"}`}
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" />
        <line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" />
        <line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>
      {/* dark = moon */}
      <svg
        {...SVG_PROPS}
        className={`${ICON_FADE} ${displayTheme === "dark" ? "opacity-100" : "opacity-0"}`}
        aria-hidden="true"
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
      {/* system = monitor */}
      <svg
        {...SVG_PROPS}
        className={`${ICON_FADE} ${displayTheme === "system" ? "opacity-100" : "opacity-0"}`}
        aria-hidden="true"
      >
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    </button>
  );
}
