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
}

const proseClasses =
  "prose prose-sm prose-stone dark:prose-invert max-w-none text-[13.5px] leading-relaxed [&_p]:my-2 [&_code]:text-[13px] [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none [&_a]:text-stone-600 dark:[&_a]:text-stone-400 [&_a]:no-underline text-stone-700 dark:text-stone-300 [&_sup_a]:text-stone-500 dark:[&_sup_a]:text-stone-400 [&_sup_a]:no-underline [&_sup_a]:font-medium [&_sup_a:hover]:text-stone-800 dark:[&_sup_a:hover]:text-stone-200";

const CLAMP_HEIGHT_PX = 460;
// Hysteresis: don't show a toggle for content that barely exceeds the clamp.
const CLAMP_BUFFER_PX = 8;

interface RenderedCitation {
  label: string;
  number: number;
  citation: OverviewCitation;
}

function SourceChips({ items }: { items: RenderedCitation[] }) {
  if (items.length === 0) return null;
  return (
    <section className="not-prose mt-6 pt-4 border-t border-stone-200 dark:border-stone-800">
      <h2 className="text-[11px] uppercase tracking-wide text-stone-400 dark:text-stone-500 font-medium mb-2">
        Sources
      </h2>
      <div className="flex flex-wrap gap-1.5">
        {items.map(({ label, number, citation }) => (
          <a
            key={label}
            id={`user-content-fn-${label}`}
            href={citation.sourceUrl}
            target="_blank"
            rel={EXTERNAL_UGC_REL}
            className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-[11px] font-medium text-stone-600 hover:bg-stone-100 hover:text-stone-900 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-300 dark:hover:bg-stone-700 dark:hover:text-stone-100 transition-colors max-w-full"
          >
            <span className="text-stone-400 dark:text-stone-500 tabular-nums">{number}</span>
            <span className="truncate">{definitionLabel(citation)}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

export function OverviewView({ page }: OverviewViewProps) {
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
    <div className="mt-5">
      <div className="bg-stone-50 dark:bg-stone-900/50 border border-stone-200 dark:border-stone-800 rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] uppercase tracking-wide text-stone-400 dark:text-stone-500 font-medium">
            Recently Shipped
          </span>
          <span className="text-[11px] text-stone-300 dark:text-stone-600">
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
              className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-stone-50 dark:from-stone-900/50 to-transparent"
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
          <div className="mt-4 pt-3 border-t border-stone-200 dark:border-stone-800 text-[11px] text-stone-400 dark:text-stone-500">
            {AI_SUMMARY_DISCLAIMER}
          </div>
        )}
      </div>
    </div>
  );
}
