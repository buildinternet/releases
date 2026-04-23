"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { OverviewPageItem } from "@/lib/api";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { markdownComponents } from "./markdown-components";

interface OverviewViewProps {
  page: OverviewPageItem;
}

const proseClasses =
  "prose prose-sm prose-stone dark:prose-invert max-w-none text-[13.5px] leading-relaxed [&_p]:my-2 [&_code]:text-[13px] [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none [&_a]:text-stone-600 dark:[&_a]:text-stone-400 [&_a]:no-underline text-stone-700 dark:text-stone-300";

const CLAMP_HEIGHT_PX = 260;
// Hysteresis: don't show a toggle for content that barely exceeds the clamp.
const CLAMP_BUFFER_PX = 8;

/**
 * The overview already lives inside an org page with a header — the AI
 * generator occasionally adds an `# Org Name` line anyway. Strip a leading
 * h1 so we don't render a redundant title.
 */
function stripLeadingH1(content: string): string {
  return content.replace(/^\s*#\s+[^\n]+\n+/, "");
}

export function OverviewView({ page }: OverviewViewProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const check = () => {
      setOverflows(el.scrollHeight > CLAMP_HEIGHT_PX + CLAMP_BUFFER_PX);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [page.content]);

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
            Overview
          </span>
          <span className="text-[11px] text-stone-300 dark:text-stone-600">
            {page.releaseCount} releases · updated {updatedDate}
          </span>
        </div>
        <div className="relative">
          <div
            ref={contentRef}
            className={proseClasses}
            style={clamped ? { maxHeight: `${CLAMP_HEIGHT_PX}px`, overflow: "hidden" } : undefined}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeShikiPlugin]}
              components={markdownComponents}
            >
              {stripLeadingH1(page.content)}
            </ReactMarkdown>
          </div>
          {clamped && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-stone-50 dark:from-stone-900/50 to-transparent"
            />
          )}
        </div>
        {overflows && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-3 text-[12px] font-medium text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200 transition-colors"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>
    </div>
  );
}
