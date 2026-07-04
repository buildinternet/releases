"use client";

import { useEffect, useMemo, useState } from "react";
import type { OverviewCitation } from "@buildinternet/releases-api-types";
import { definitionLabel } from "@/lib/overview-citations";
import { EXTERNAL_UGC_REL, isSafeHref } from "@/lib/sanitize";

export interface RenderedCitation {
  label: string;
  number: number;
  citation: OverviewCitation;
}

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
 * Chip-based "Sources" footer for an overview, rendered in place of the GFM
 * footnotes `<section>` (see `OverviewView`'s `section` component override).
 * Kept as its own client island so the overview body itself — the bulk of the
 * markup and the `react-markdown` + shiki render — stays a server component and
 * ships no JS. Only the collapse toggle + hashchange auto-expand need the client.
 */
export function OverviewSourceChips({ items }: { items: RenderedCitation[] }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = items.length > SOURCE_COLLAPSE_THRESHOLD;

  // Anchor ids of the chips hidden while collapsed. In-body footnote
  // superscripts (e.g. ¹³) link to `#user-content-fn-<label>`; if the target
  // is in the collapsed tail we auto-expand so the jump lands somewhere.
  const tailIds = useMemo(
    () =>
      new Set(
        items.slice(SOURCE_COLLAPSE_THRESHOLD).map(({ label }) => `user-content-fn-${label}`),
      ),
    [items],
  );

  useEffect(() => {
    if (!collapsible) return;
    const maybeExpand = () => {
      const raw = window.location.hash.slice(1);
      let id: string;
      try {
        id = decodeURIComponent(raw);
      } catch {
        id = raw; // malformed %-encoding — fall back to the raw fragment
      }
      if (id && tailIds.has(id)) {
        setExpanded(true);
        // The browser already tried to scroll to a then-`display:none` chip and
        // gave up; re-scroll once React has revealed it.
        requestAnimationFrame(() => {
          document.getElementById(id)?.scrollIntoView({ block: "nearest" });
        });
      }
    };
    maybeExpand();
    window.addEventListener("hashchange", maybeExpand);
    return () => window.removeEventListener("hashchange", maybeExpand);
  }, [collapsible, tailIds]);

  if (items.length === 0) return null;

  const hiddenCount = items.length - SOURCE_COLLAPSE_THRESHOLD;

  return (
    <section className="not-prose mt-6 pt-4 border-t border-stone-200 dark:border-stone-800">
      <h2 className="text-[11px] uppercase tracking-wide text-stone-400 dark:text-stone-500 font-medium mb-2">
        Sources
      </h2>
      <div className="flex flex-wrap gap-1.5">
        {items.map(({ label, number, citation }, i) => {
          const hiddenNow = collapsible && !expanded && i >= SOURCE_COLLAPSE_THRESHOLD;
          return (
            <a
              key={label}
              id={`user-content-fn-${label}`}
              // Guard the scheme: an overview citation is expected to be an
              // http(s) source URL, but never render a clickable javascript:/
              // data: href. Unsafe values drop to a non-navigable anchor that
              // still keeps the footnote-jump id and the label.
              href={isSafeHref(citation.sourceUrl) ? citation.sourceUrl : undefined}
              target="_blank"
              rel={EXTERNAL_UGC_REL}
              className={`${hiddenNow ? "hidden" : "inline-flex"} ${chipClass}`}
            >
              <span className="text-stone-400 dark:text-stone-500 tabular-nums">{number}</span>
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
