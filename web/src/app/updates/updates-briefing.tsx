"use client";

import { useState } from "react";
import type { OverviewPageItem } from "@/lib/api";
import { stripLeadingHeading } from "@/lib/overview-citations";
import { stripMarkdown } from "@/lib/og-helpers";

/**
 * Compact "Recently shipped" briefing card for `/updates` (design option 8a).
 * Consumes the same `OverviewPageItem` payload as `OverviewView` — no forked
 * data fetching — but presents it compressed to a few lines instead of the
 * full clamp-at-1800px prose card, matching the mockup's dense header card.
 *
 * `OverviewView`'s existing `OverviewClamp` is effectively a no-op at this
 * scale (its clamp height is tuned to catch only runaway AI output, not to
 * produce a 2-3 line teaser), so this is a small page-specific presentation
 * rather than a new `OverviewView` variant — the brief's fallback option.
 * Deliberately plain-text (via the shared `stripMarkdown` OG helper) rather
 * than a full markdown render, so this client island stays light.
 */
export function UpdatesBriefing({ page }: { page: OverviewPageItem }) {
  const [expanded, setExpanded] = useState(false);
  const text = stripMarkdown(stripLeadingHeading(page.content));
  const updatedDate = new Date(page.updatedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className="my-5 flex gap-3.5 rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
      >
        <path d="M12 3.5l1.5 4.2L18 9l-4.5 1.3L12 14.5l-1.5-4.2L6 9l4.5-1.3z" />
        <path d="M18.6 14.2l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6z" />
      </svg>
      <div className="min-w-0">
        <div className="mb-1 flex items-baseline gap-2.5">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.1em] text-stone-500 dark:text-stone-400">
            Recently shipped
          </h2>
          <span className="text-[11.5px] text-stone-400 dark:text-stone-500">
            {page.releaseCount} releases · updated {updatedDate}
          </span>
        </div>
        <p
          className={
            "text-[13.5px] leading-relaxed text-stone-600 dark:text-stone-300 " +
            (expanded ? "" : "line-clamp-3")
          }
        >
          {text}
        </p>
        {!expanded && text.length > 220 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-expanded={false}
            className="mt-1.5 text-[12px] font-medium text-stone-500 transition-colors hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
          >
            Show more
          </button>
        )}
      </div>
    </div>
  );
}
