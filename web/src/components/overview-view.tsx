"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { OverviewPageItem } from "@/lib/api";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { applyCitationMarkers } from "@/lib/overview-citations";
import { markdownComponents } from "./markdown-components";

interface OverviewViewProps {
  page: OverviewPageItem;
}

const proseClasses =
  "prose prose-sm prose-stone dark:prose-invert max-w-none text-[13.5px] leading-relaxed [&_p]:my-2 [&_code]:text-[13px] [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none [&_a]:text-stone-600 dark:[&_a]:text-stone-400 [&_a]:no-underline text-stone-700 dark:text-stone-300 [&_sup_a]:text-stone-500 dark:[&_sup_a]:text-stone-400 [&_sup_a]:no-underline [&_sup_a]:font-medium [&_sup_a:hover]:text-stone-800 dark:[&_sup_a:hover]:text-stone-200 [&_section.footnotes]:mt-6 [&_section.footnotes]:pt-4 [&_section.footnotes]:border-t [&_section.footnotes]:border-stone-200 dark:[&_section.footnotes]:border-stone-800 [&_section.footnotes_h2]:text-[11px] [&_section.footnotes_h2]:uppercase [&_section.footnotes_h2]:tracking-wide [&_section.footnotes_h2]:text-stone-400 dark:[&_section.footnotes_h2]:text-stone-500 [&_section.footnotes_h2]:font-medium [&_section.footnotes_h2]:mb-2 [&_section.footnotes_ol]:text-[12px] [&_section.footnotes_ol]:my-0 [&_section.footnotes_ol]:pl-5";

const CLAMP_HEIGHT_PX = 460;
// Hysteresis: don't show a toggle for content that barely exceeds the clamp.
const CLAMP_BUFFER_PX = 8;

export function OverviewView({ page }: OverviewViewProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const contentId = useId();
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Memoize the citation injection — re-runs only when content or citations
  // change. Pass contentId in so the footnote ids don't collide across two
  // overviews on the same page.
  const renderedContent = useMemo(
    () => applyCitationMarkers(page.content, page.citations, contentId).content,
    [page.content, page.citations, contentId],
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
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeShikiPlugin]}
              components={markdownComponents}
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
            AI-generated summaries may contain mistakes.
          </div>
        )}
      </div>
    </div>
  );
}
