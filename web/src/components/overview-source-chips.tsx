"use client";

import { useState } from "react";
import type { OverviewCitation } from "@buildinternet/releases-api-types";
import { citationHref, definitionLabel, isInternalCitation } from "@/lib/overview-citations";
import { EXTERNAL_UGC_REL, isSafeHref } from "@/lib/sanitize";

// Collapse the Sources footer once it grows past this many chips (so 7+
// citations show the first 6 + a "Show N more" toggle). Long-titled citations
// each take a full row, so an uncollapsed list of 14 stacks very tall.
const SOURCE_COLLAPSE_THRESHOLD = 6;

// Everything but the leading display utility — that's toggled per-chip so the
// `hidden`/`inline-flex` swap actually wins (the `hidden` *attribute* loses to
// an `inline-flex` author class).
const chipClass =
  "items-center gap-1.5 rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-[11px] font-medium text-stone-600 hover:bg-stone-100 hover:text-stone-900 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-300 dark:hover:bg-stone-700 dark:hover:text-stone-100 transition-colors max-w-full";

/**
 * Chip-based "Sources" footer for an overview (#1934). Each chip links to the
 * source the overview drew on — preferring the canonical on-registry release
 * page (internal, crawlable, same-tab so link equity stays on-domain) and
 * falling back to the external source URL (new tab + UGC rel) when the source
 * didn't resolve to a release. Kept a client island only for the collapse
 * toggle; the overview body stays a server component.
 */
export function OverviewSourceChips({
  citations,
}: {
  citations?: readonly OverviewCitation[] | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const items = citations ?? [];
  const collapsible = items.length > SOURCE_COLLAPSE_THRESHOLD;

  if (items.length === 0) return null;

  const hiddenCount = items.length - SOURCE_COLLAPSE_THRESHOLD;

  return (
    <section className="not-prose mt-6 pt-4 border-t border-stone-200 dark:border-stone-800">
      <h2 className="text-[11px] uppercase tracking-wide text-stone-400 dark:text-stone-500 font-medium mb-2">
        Sources
      </h2>
      <div className="flex flex-wrap gap-1.5">
        {items.map((citation, i) => {
          const hiddenNow = collapsible && !expanded && i >= SOURCE_COLLAPSE_THRESHOLD;
          const href = citationHref(citation);
          const internal = isInternalCitation(citation);
          // Internal release links: same-tab, no rel — let crawlers follow and
          // link equity flow to the on-registry page. External sources: new tab
          // + UGC rel. Guard the scheme either way; unsafe values drop to a
          // non-navigable chip that still shows the label.
          const external = !internal;
          return (
            <a
              key={`${href}-${i}`}
              href={isSafeHref(href) ? href : undefined}
              {...(external ? { target: "_blank", rel: EXTERNAL_UGC_REL } : {})}
              className={`${hiddenNow ? "hidden" : "inline-flex"} ${chipClass}`}
            >
              <span className="min-w-0 truncate">{definitionLabel(citation)}</span>
            </a>
          );
        })}
      </div>
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-3 text-[12px] font-medium text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200 transition-colors"
        >
          {expanded
            ? "Show fewer"
            : `Show ${hiddenCount} more source${hiddenCount === 1 ? "" : "s"}`}
        </button>
      )}
    </section>
  );
}
