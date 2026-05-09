"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HomepageTickerQuery } from "@/lib/graphql/__generated__/graphql";
import { formatRelativeDate } from "@/lib/formatters";

export type TickerRelease = HomepageTickerQuery["latestReleases"]["items"][number];
type Slide = { release: TickerRelease; relative: string | null };

const MAX_ITEMS = 20;

/**
 * Title-quality filter applied on top of the server's `?exclude=github`
 * filter. Drops bare-version updates where the title is just the version
 * with no human-readable context ("8.4.3", "v1.2.0", or a string that
 * collapses to nothing once the version slug is removed). The ticker is a
 * marketing surface; if there's no headline, it's not worth a slot.
 */
function isMeaningfulRelease(r: TickerRelease): boolean {
  const title = (r.title ?? "").trim();
  if (!title) return false;
  const version = (r.version ?? "").trim();
  if (/^v?\d+(?:\.\d+){1,3}([-+][\w.]+)?$/i.test(title)) return false;
  if (version) {
    const stripped = title.split(version).join(" ").replace(/\s+/g, " ").trim();
    if (stripped.length < 4) return false;
  }
  return true;
}

function pickLabel(r: TickerRelease): string {
  return r.title ?? r.version ?? "(untitled)";
}

// Lucide-style "activity" pulse — one cycle of an EKG line. Animated by
// `animate-pulse` on the parent so the whole stroke softly fades.
function ActivityIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

function Card({ slide }: { slide: Slide }) {
  const { release, relative } = slide;
  return (
    <Link
      href={`/release/${release.id}`}
      data-ticker-card
      className="snap-start flex-none basis-[88%] sm:basis-[calc(33.333%-0.5rem)] lg:basis-[calc(25%-0.5625rem)] flex flex-col gap-2 p-4 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 hover:border-stone-300 dark:hover:border-stone-700 hover:shadow-sm transition-all shadow-[0_1px_2px_rgba(0,0,0,0.02)]"
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-medium text-[13px] text-stone-900 dark:text-stone-100 truncate flex-1">
          {release.source.org.name}
        </span>
        {relative && (
          <span className="font-mono text-[11px] text-stone-400 dark:text-stone-500 whitespace-nowrap">
            {relative}
          </span>
        )}
      </div>
      <p className="text-[13px] text-stone-700 dark:text-stone-300 line-clamp-2 leading-snug min-h-[2.5rem]">
        {pickLabel(release)}
      </p>
      {release.version && (
        <span className="font-mono text-[11px] text-stone-500 dark:text-stone-400 bg-stone-100 dark:bg-stone-800 px-1.5 py-0.5 rounded self-start whitespace-nowrap max-w-full truncate">
          {release.version}
        </span>
      )}
    </Link>
  );
}

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={direction === "left" ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6"} />
    </svg>
  );
}

export function ShippingNowTicker({ releases }: { releases: TickerRelease[] }) {
  const items = useMemo<Slide[]>(
    () =>
      releases
        .filter(isMeaningfulRelease)
        .slice(0, MAX_ITEMS)
        .map((release) => ({
          release,
          relative: release.publishedAt ? formatRelativeDate(release.publishedAt) : null,
        })),
    [releases],
  );

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

  const updateNav = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // 1px tolerance for subpixel rounding at the edges.
    setCanPrev(el.scrollLeft > 1);
    setCanNext(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    updateNav();
    el.addEventListener("scroll", updateNav, { passive: true });
    // Card widths are responsive; resize can flip overflow on/off.
    const ro = new ResizeObserver(updateNav);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", updateNav);
      ro.disconnect();
    };
  }, [updateNav, items.length]);

  const scrollByCard = useCallback((dir: 1 | -1) => {
    const el = scrollerRef.current;
    if (!el) return;
    const card = el.querySelector<HTMLElement>("[data-ticker-card]");
    const gap = parseFloat(getComputedStyle(el).columnGap || "12") || 12;
    const step = (card?.offsetWidth ?? el.clientWidth * 0.85) + gap;
    el.scrollBy({ left: dir * step, behavior: "smooth" });
  }, []);

  if (items.length === 0) return null;

  const showNav = canPrev || canNext;

  return (
    <section aria-label="Recent releases across the platform" className="max-w-4xl mx-auto mb-10">
      <div className="flex items-center gap-2 px-6 mb-3">
        <span className="animate-pulse text-amber-500 dark:text-amber-400">
          <ActivityIcon />
        </span>
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-300">
          Recent
        </h2>
        {showNav && (
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => scrollByCard(-1)}
              disabled={!canPrev}
              aria-label="Scroll to previous releases"
              className="flex h-7 w-7 items-center justify-center rounded-md border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 hover:border-stone-300 dark:hover:border-stone-700 disabled:opacity-30 disabled:pointer-events-none transition-colors"
            >
              <ChevronIcon direction="left" />
            </button>
            <button
              type="button"
              onClick={() => scrollByCard(1)}
              disabled={!canNext}
              aria-label="Scroll to next releases"
              className="flex h-7 w-7 items-center justify-center rounded-md border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 hover:border-stone-300 dark:hover:border-stone-700 disabled:opacity-30 disabled:pointer-events-none transition-colors"
            >
              <ChevronIcon direction="right" />
            </button>
          </div>
        )}
      </div>
      {/* Horizontal scroll-snap row. `[scrollbar-width:none]` +
          `[&::-webkit-scrollbar]:hidden` hide the native scrollbar without
          breaking scroll/wheel/touch behavior. The bottom padding + negative
          margin reserves space for hover-shadow lift without inflating the
          gap to the next section. */}
      <div
        ref={scrollerRef}
        className="flex gap-3 overflow-x-auto snap-x snap-mandatory px-6 pb-2 -mb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {items.map((slide) => (
          <Card key={slide.release.id} slide={slide} />
        ))}
      </div>
    </section>
  );
}
