"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { remarkPlugins } from "@/lib/markdown-plugins";
import type { OverviewCitation } from "@buildinternet/releases-api-types";
import type { OverviewPageItem } from "@/lib/api";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { applyCitationMarkers, definitionLabel } from "@/lib/overview-citations";
import { EXTERNAL_UGC_REL } from "@/lib/sanitize";
import { AI_SUMMARY_DISCLAIMER } from "@/lib/copy";
import { markdownComponents } from "./markdown-components";

interface OverviewViewProps {
  page: OverviewPageItem;
  /**
   * `"org"` renders the card with the org-page redesign tokens (accent eyebrow,
   * `--surface-2` card) — only safe inside `.org-surface`, where the tokens are
   * defined. `"default"` (product pages, timeline fallback) keeps the stone
   * styling. The markdown/citation pipeline is identical across both.
   */
  variant?: "default" | "org";
}

const CHROME = {
  default: {
    outer: "mt-5",
    card: "rounded-lg border border-stone-200 bg-stone-50 p-5 dark:border-stone-800 dark:bg-stone-900/50",
    eyebrow: "text-[11px] font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500",
    meta: "text-[11px] text-stone-300 dark:text-stone-600",
    fade: "from-stone-50 dark:from-stone-900/50",
    disclaimer: "border-stone-200 text-stone-400 dark:border-stone-800 dark:text-stone-500",
  },
  org: {
    outer: "mb-6",
    card: "rounded-[14px] border border-[var(--line)] bg-[var(--surface-2)] p-[22px]",
    eyebrow: "font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--accent)]",
    meta: "font-mono text-[11.5px] text-[var(--fg-3)]",
    fade: "from-[var(--surface-2)]",
    disclaimer: "border-[var(--line)] text-[var(--fg-3)]",
  },
} as const;

const proseClasses =
  "prose prose-sm prose-stone dark:prose-invert max-w-none text-[13.5px] leading-relaxed [&_p]:my-2 [&_code]:text-[13px] [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none [&_a]:text-stone-600 dark:[&_a]:text-stone-400 [&_a]:no-underline text-stone-700 dark:text-stone-300 [&_sup_a]:text-stone-500 dark:[&_sup_a]:text-stone-400 [&_sup_a]:no-underline [&_sup_a]:font-medium [&_sup_a:hover]:text-stone-800 dark:[&_sup_a:hover]:text-stone-200";

// Effectively disabled for typical overviews — only runaway AI output will
// trip the clamp. Raised from the original 460px so the majority of pages
// render fully expanded without a "Show more" click, and so the full prose
// is immediately visible to crawlers without JS interaction.
const CLAMP_HEIGHT_PX = 1800;
// Hysteresis: don't show a toggle for content that barely exceeds the clamp.
const CLAMP_BUFFER_PX = 8;

interface RenderedCitation {
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

function SourceChips({ items }: { items: RenderedCitation[] }) {
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
              href={citation.sourceUrl}
              target="_blank"
              rel={EXTERNAL_UGC_REL}
              className={`${hiddenNow ? "hidden" : "inline-flex"} ${chipClass}`}
            >
              <span className="text-stone-400 dark:text-stone-500 tabular-nums">{number}</span>
              <span className="truncate">{definitionLabel(citation)}</span>
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

export function OverviewView({ page, variant = "default" }: OverviewViewProps) {
  const chrome = CHROME[variant];
  const contentRef = useRef<HTMLDivElement>(null);
  const contentId = useId();
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Memoize the citation injection — re-runs only when content or citations
  // change. Pass contentId in so the footnote ids don't collide across two
  // overviews on the same page.
  const { content: renderedContent, rendered: renderedCitations } = useMemo(
    () => applyCitationMarkers(page.content, page.citations, contentId),
    [page.content, page.citations, contentId],
  );

  // Replace the default GFM-rendered footnotes <section> with our chip-based
  // Sources block. Anchor IDs on the chips match the `user-content-fn-${label}`
  // targets the in-body superscript markers expect, so click-to-jump still works.
  const components = useMemo(
    () => ({
      ...markdownComponents,
      section: (props: any) => {
        const className = props.className as string | undefined;
        if (className?.split(/\s+/).includes("footnotes")) {
          return <SourceChips items={renderedCitations} />;
        }
        return <section {...props} />;
      },
    }),
    [renderedCitations],
  );

  useEffect(() => {
    setExpanded(false);
    const el = contentRef.current;
    if (!el) return;
    const check = () => {
      setOverflows(el.scrollHeight > CLAMP_HEIGHT_PX + CLAMP_BUFFER_PX);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [renderedContent]);

  const updatedDate = new Date(page.updatedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  const clamped = overflows && !expanded;

  return (
    <div className={chrome.outer}>
      <div className={chrome.card}>
        <div className="flex items-center justify-between mb-3">
          <span className={chrome.eyebrow}>Recently Shipped</span>
          <span className={chrome.meta}>
            {page.releaseCount} releases · updated {updatedDate}
          </span>
        </div>
        <div className="relative">
          <div
            ref={contentRef}
            id={contentId}
            className={proseClasses}
            style={clamped ? { maxHeight: `${CLAMP_HEIGHT_PX}px`, overflow: "hidden" } : undefined}
          >
            <ReactMarkdown
              remarkPlugins={remarkPlugins}
              rehypePlugins={[rehypeShikiPlugin]}
              components={components}
            >
              {renderedContent}
            </ReactMarkdown>
          </div>
          {clamped && (
            <div
              aria-hidden
              className={`pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t to-transparent ${chrome.fade}`}
            />
          )}
        </div>
        {clamped && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-expanded={false}
            aria-controls={contentId}
            className="mt-3 text-[12px] font-medium text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200 transition-colors"
          >
            Show more
          </button>
        )}
        {!clamped && (
          <div className={`mt-4 border-t pt-3 text-[11px] ${chrome.disclaimer}`}>
            {AI_SUMMARY_DISCLAIMER}
          </div>
        )}
      </div>
    </div>
  );
}
