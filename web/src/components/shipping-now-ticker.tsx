"use client";

import Link from "next/link";
import { useMemo } from "react";
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

  if (items.length === 0) return null;

  return (
    <section aria-label="Recent releases across the platform" className="max-w-4xl mx-auto mb-10">
      <div className="flex items-center gap-2 px-6 mb-3 text-amber-700 dark:text-amber-300">
        <span className="animate-pulse text-amber-500 dark:text-amber-400">
          <ActivityIcon />
        </span>
        <h2 className="text-[11px] font-bold uppercase tracking-wider">Recent</h2>
      </div>
      {/* Horizontal scroll-snap row. `[scrollbar-width:none]` +
          `[&::-webkit-scrollbar]:hidden` hide the native scrollbar without
          breaking scroll/wheel/touch behavior. The bottom padding + negative
          margin reserves space for hover-shadow lift without inflating the
          gap to the next section. */}
      <div className="flex gap-3 overflow-x-auto snap-x snap-mandatory px-6 pb-2 -mb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((slide) => (
          <Card key={slide.release.id} slide={slide} />
        ))}
      </div>
    </section>
  );
}
