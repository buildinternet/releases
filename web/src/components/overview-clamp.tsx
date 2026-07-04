"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// Effectively disabled for typical overviews — only runaway AI output will
// trip the clamp. Raised from the original 460px so the majority of pages
// render fully expanded without a "Show more" click, and so the full prose
// is immediately visible to crawlers without JS interaction.
const CLAMP_HEIGHT_PX = 1800;
// Hysteresis: don't show a toggle for content that barely exceeds the clamp.
const CLAMP_BUFFER_PX = 8;

/**
 * Client wrapper that measures the (server-rendered) overview body and clamps
 * it behind a "Show more" toggle only when it runs unusually long. The markdown
 * itself is rendered on the server and arrives as `children`, so `react-markdown`
 * + shiki never ship to the browser — this island only measures and toggles.
 *
 * The disclaimer lives here too because it and the "Show more" button are
 * mutually exclusive on clamp state (matching the pre-split behavior): a clamped
 * body shows the toggle, an unclamped body shows the disclaimer.
 */
export function OverviewClamp({
  children,
  contentId,
  proseClasses,
  fadeClass,
  disclaimerClass,
  disclaimer,
}: {
  children: ReactNode;
  contentId: string;
  proseClasses: string;
  fadeClass: string;
  disclaimerClass: string;
  disclaimer: string;
}) {
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
  }, []);

  const clamped = overflows && !expanded;

  return (
    <>
      <div className="relative">
        <div
          ref={contentRef}
          id={contentId}
          className={proseClasses}
          style={clamped ? { maxHeight: `${CLAMP_HEIGHT_PX}px`, overflow: "hidden" } : undefined}
        >
          {children}
        </div>
        {clamped && (
          <div
            aria-hidden
            className={`pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t to-transparent ${fadeClass}`}
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
        <div className={`mt-4 border-t pt-3 text-[11px] ${disclaimerClass}`}>{disclaimer}</div>
      )}
    </>
  );
}
