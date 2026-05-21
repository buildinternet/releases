"use client";

import { useState } from "react";

/**
 * Collapsible "SDKs" block for the org sources table. Renders a full-width
 * subheading row (its own `<tr>`) with a disclosure toggle; when open, renders
 * the SDK member rows passed as `children`. Mirrors the disclosure idiom in
 * `inactive-sources-toggle.tsx`.
 */
export function SdkSourceGroup({
  colSpan,
  count,
  preview,
  children,
}: {
  colSpan: number;
  count: number;
  preview: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <tr className="bg-stone-50/60 dark:bg-stone-900/40">
        <td colSpan={colSpan} className="px-3 py-2">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={`${count} SDK ${count === 1 ? "source" : "sources"}`}
            className="flex items-center gap-2 w-full text-left text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
          >
            <svg
              className={`w-3 h-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            <span className="text-[13px] font-semibold">SDKs</span>
            {!open && preview && (
              <span className="flex-1 min-w-0 truncate text-[12px] text-stone-400 dark:text-stone-500">
                {preview}
              </span>
            )}
          </button>
        </td>
      </tr>
      {open && children}
    </>
  );
}
