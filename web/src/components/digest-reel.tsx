"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { OrgAvatar } from "./org-avatar";
import { DigestIcon } from "./digest-icons";
import { DigestSectionRow } from "./digest-reel-section";
import { weekRangeLabel } from "@/lib/digest-format";
import { digestHref, type ReelCard, type ReelPreview } from "@/lib/digest-reel";

/** Card width (360px) + track gap (16px): one arrow press advances one card. */
const SCROLL_STEP = 376;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={dir === "left" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
    </svg>
  );
}

/** One issue card. An article, not one big link: the title, each section row,
 *  and the footer are separate links. */
function DigestCard({ digest }: { digest: ReelCard }) {
  const href = digestHref(digest);
  return (
    <article className="flex w-[88%] flex-none snap-start flex-col gap-3 rounded-xl border border-stone-200 bg-white p-[18px] shadow-sm sm:h-[440px] sm:w-[360px] sm:gap-3.5 sm:px-[22px] sm:pt-5 sm:pb-[18px] dark:border-stone-800 dark:bg-stone-900 dark:shadow-black/25">
      <div className="flex items-center gap-2.5">
        {digest.orgs.length > 0 && (
          <div className="flex pr-1.5">
            {digest.orgs.map((o) => (
              <span
                key={o.slug}
                className="-mr-1.5 rounded-full ring-2 ring-white dark:ring-stone-900"
              >
                <OrgAvatar
                  avatarUrl={o.avatarUrl}
                  githubHandle={o.githubHandle}
                  name={o.name}
                  size={20}
                />
              </span>
            ))}
          </div>
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-stone-800 dark:text-stone-200">
          {digest.collection.name}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-stone-400 dark:text-stone-500">
          {weekRangeLabel(digest.weekStart, { year: false })}
        </span>
      </div>
      <h3 className="line-clamp-3 text-[18px] leading-[1.32] font-semibold tracking-[-0.012em] text-stone-900 sm:text-[19px] dark:text-stone-50">
        <Link
          href={href}
          className="hover:underline decoration-stone-300 underline-offset-2 dark:decoration-stone-600"
        >
          {digest.title}
        </Link>
      </h3>
      {digest.intro && (
        <p className="line-clamp-4 text-[13.5px] leading-[1.55] text-stone-500 sm:line-clamp-3 dark:text-stone-400">
          {digest.intro}
        </p>
      )}
      {digest.sections.length > 0 && (
        <div className="mt-auto flex flex-col gap-0.5 border-t border-dashed border-stone-200 pt-3 dark:border-stone-800">
          <div className="mb-1 font-mono text-[10px] tracking-[0.14em] text-stone-400 uppercase dark:text-stone-500">
            In this issue
          </div>
          {digest.sections.map((s, i) => (
            <DigestSectionRow key={s.anchor} digest={digest} section={s} index={i} />
          ))}
        </div>
      )}
      <div
        className={`flex items-center justify-between border-t border-stone-200 pt-3 dark:border-stone-800 ${
          digest.sections.length > 0 ? "" : "mt-auto"
        }`}
      >
        <span className="font-mono text-[11px] text-stone-400 dark:text-stone-500">
          {plural(digest.releaseCount, "release", "releases")} ·{" "}
          {plural(digest.orgCount, "org", "orgs")}
        </span>
        <Link
          href={href}
          aria-label={`Read issue: ${digest.collection.name} digest`}
          className="text-[12.5px] font-medium text-[var(--accent)] hover:underline"
        >
          Read issue →
        </Link>
      </div>
    </article>
  );
}

/**
 * Homepage "Weekly digests" band: a full-bleed, natively scrolling reel of the
 * newest week's collection digests (featured first, then busiest), with the
 * overflow listed under "Also this week". Renders nothing for an empty list.
 * `preview` is the server-trimmed payload from `toReelPreview` — already
 * split into cards/overflow, so nothing here re-derives it per render.
 */
export function DigestReel({ preview }: { preview: ReelPreview }) {
  const headingId = useId();
  const trackRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  const measure = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    setEdges({
      start: el.scrollLeft <= 4,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4,
    });
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  const { cards, more } = preview;
  if (cards.length === 0) return null;
  const weekStart = cards[0].weekStart;

  const scroll = (dir: 1 | -1) => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    trackRef.current?.scrollBy({ left: dir * SCROLL_STEP, behavior: reduce ? "auto" : "smooth" });
  };

  const arrowClass =
    "flex size-11 items-center justify-center rounded-[10px] border border-stone-200 bg-white text-stone-700 hover:bg-stone-50 disabled:cursor-default disabled:text-stone-300 disabled:hover:bg-white dark:border-stone-800 dark:bg-stone-900 dark:text-stone-200 dark:hover:bg-stone-800 dark:disabled:text-stone-600 dark:disabled:hover:bg-stone-900";

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-5 border-y border-stone-200 bg-stone-100/60 pt-9 pb-7 sm:gap-7 sm:pt-[52px] sm:pb-9 dark:border-stone-900 dark:bg-[#110f0e]"
      // Left edge of the reel lines up with the 1240px content column and
      // bleeds off the right edge of the viewport.
      style={
        { "--reel-gutter": "max(1.5rem, calc((100vw - 1240px) / 2 + 1.5rem))" } as CSSProperties
      }
    >
      <div className="mx-auto flex w-full max-w-[1240px] items-end gap-6 px-6">
        <div className="flex flex-1 flex-col gap-1.5 sm:gap-2">
          <div className="flex items-center gap-2">
            <span className="text-stone-400 dark:text-stone-500">
              <DigestIcon size={13} />
            </span>
            <h2
              id={headingId}
              className="text-[11px] font-bold tracking-wider text-stone-600 uppercase dark:text-stone-300"
            >
              Weekly digests
            </h2>
          </div>
          <p className="text-[19px] leading-tight font-semibold tracking-[-0.015em] text-stone-900 sm:text-[22px] dark:text-stone-50">
            The week in releases, written up by collection
          </p>
          <p className="text-[13px] text-stone-500 sm:text-[14px] dark:text-stone-400">
            New issues every Monday. Week of {weekRangeLabel(weekStart, { year: false })} ·{" "}
            {plural(preview.totalCount, "collection", "collections")}
          </p>
        </div>
        <div className="hidden gap-2 sm:flex">
          <button
            type="button"
            aria-label="Previous digests"
            disabled={edges.start}
            onClick={() => scroll(-1)}
            className={arrowClass}
          >
            <Chevron dir="left" />
          </button>
          <button
            type="button"
            aria-label="Next digests"
            disabled={edges.end}
            onClick={() => scroll(1)}
            className={arrowClass}
          >
            <Chevron dir="right" />
          </button>
        </div>
      </div>

      <div
        ref={trackRef}
        onScroll={measure}
        className="flex snap-x snap-mandatory scroll-pl-[var(--reel-gutter)] gap-3 overflow-x-auto py-1 pr-6 pl-[var(--reel-gutter)] [scrollbar-width:none] sm:gap-4 [&::-webkit-scrollbar]:hidden"
      >
        {cards.map((d) => (
          <DigestCard key={d.collection.slug} digest={d} />
        ))}
      </div>

      <div className="mx-auto flex w-full max-w-[1240px] flex-wrap items-center gap-x-5 gap-y-2 px-6 text-[13px]">
        {more.length > 0 && (
          <>
            <span className="font-mono text-[10px] tracking-[0.14em] text-stone-400 uppercase dark:text-stone-500">
              Also this week
            </span>
            {more.map((d) => (
              <Link
                key={d.collection.slug}
                href={digestHref(d)}
                className="text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-100"
              >
                {d.collection.name}
              </Link>
            ))}
          </>
        )}
        <Link
          href="/collections"
          className="ml-auto text-[12px] text-stone-500 underline decoration-stone-300 underline-offset-2 hover:text-stone-700 dark:text-stone-400 dark:decoration-stone-600 dark:hover:text-stone-200"
        >
          All collections →
        </Link>
      </div>
    </section>
  );
}
