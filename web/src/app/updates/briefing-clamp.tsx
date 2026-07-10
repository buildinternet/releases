"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// Hysteresis: don't offer a toggle for an overview that is only its lede.
const CLAMP_BUFFER_PX = 8;

const proseClasses =
  "prose prose-sm prose-stone dark:prose-invert max-w-none break-words text-[13.5px] leading-relaxed text-stone-600 dark:text-stone-300 [&_p]:my-0 [&_p+p]:mt-2.5 [&_strong]:text-stone-800 dark:[&_strong]:text-stone-100 [&_code]:text-[12.5px] [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:font-normal [&_code::before]:content-none [&_code::after]:content-none [&_a]:text-stone-600 dark:[&_a]:text-stone-400 [&_a]:no-underline";

/**
 * Client island that collapses the (server-rendered) briefing markdown to its
 * lede paragraph behind a "Show more" toggle. `react-markdown` runs on the
 * server and arrives as `children`, so none of it ships to the browser.
 *
 * The collapsed height is measured from the first block rather than fixed at a
 * line count: the body is several paragraphs, not one text node (so
 * `line-clamp-3` doesn't apply), and cutting at the paragraph boundary keeps
 * the fade from slicing a line of the second paragraph in half at any width.
 */
export function BriefingClamp({ children, contentId }: { children: ReactNode; contentId: string }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [ledeHeight, setLedeHeight] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const check = () => {
      const lede = el.firstElementChild as HTMLElement | null;
      if (!lede) return;
      const h = lede.offsetHeight;
      setLedeHeight(el.scrollHeight > h + CLAMP_BUFFER_PX ? h : null);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const overflows = ledeHeight !== null;
  const clamped = overflows && !expanded;

  return (
    <>
      <div
        ref={contentRef}
        id={contentId}
        className={proseClasses}
        style={clamped ? { maxHeight: `${ledeHeight}px`, overflow: "hidden" } : undefined}
      >
        {children}
      </div>
      {overflows && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={contentId}
          className="mt-1.5 text-[12px] font-medium text-stone-500 transition-colors hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}
