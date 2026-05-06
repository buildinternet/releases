"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { HomepageTickerQuery } from "@/lib/graphql/__generated__/graphql";
import { formatRelativeDate } from "@/lib/formatters";

export type TickerRelease = HomepageTickerQuery["latestReleases"]["items"][number];
type Slide = { release: TickerRelease; relative: string | null };

const ROTATION_MS = 3500;
const TRANSITION_MS = 500;
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

/**
 * Resolves the chevron-link target for a release:
 *   1. Original source URL (opens in a new tab) if available.
 *   2. The org page (`/{orgSlug}`) as a fallback.
 *   3. `null` when neither is available — chevron is hidden.
 *
 * The previous `/source/{slug}` shape was a 404 — bare-source paths only
 * resolve via the legacy redirect when the slug is globally unique, which
 * isn't guaranteed since #690.
 */
function chevronTarget(
  r: TickerRelease,
): { href: string; external: boolean; label: string } | null {
  if (r.url) {
    return { href: r.url, external: true, label: `Open ${r.source.name} release in a new tab` };
  }
  if (r.source.org.slug) {
    return {
      href: `/${r.source.org.slug}`,
      external: false,
      label: `More from ${r.source.name}`,
    };
  }
  return null;
}

function Row({ slide }: { slide: Slide }) {
  const { release, relative } = slide;
  return (
    <Link
      href={`/release/${release.id}`}
      className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-3 h-16 sm:h-11 px-4 py-2 sm:py-0 text-[13px] hover:bg-stone-50 dark:hover:bg-stone-800/40 transition-colors"
    >
      {/* Top row on mobile · left side on desktop */}
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        <span className="font-medium text-stone-900 dark:text-stone-100 sm:min-w-[110px] truncate">
          {release.source.org.name}
        </span>
        {release.version && (
          <span className="font-mono text-[11px] text-stone-500 dark:text-stone-400 bg-stone-100 dark:bg-stone-800 px-1.5 py-0.5 rounded whitespace-nowrap">
            {release.version}
          </span>
        )}
        {relative && (
          <span className="ml-auto sm:hidden font-mono text-[11px] text-stone-400 dark:text-stone-500 whitespace-nowrap">
            {relative}
          </span>
        )}
      </div>
      {/* Title — second line on mobile, middle column on desktop */}
      <span className="flex-1 min-w-0 text-stone-700 dark:text-stone-300 truncate">
        {pickLabel(release)}
      </span>
      {relative && (
        <span className="hidden sm:inline font-mono text-[11px] text-stone-400 dark:text-stone-500 whitespace-nowrap">
          {relative}
        </span>
      )}
    </Link>
  );
}

export function ShippingNowTicker({ releases }: { releases: TickerRelease[] }) {
  // Pre-format relative dates here so the ticker doesn't recompute
  // `Date.now()` and re-parse ISO strings for every row on every tick (21
  // rows × every 3.5s = a lot of needless work).
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

  // Append a duplicate of the first item so the slide that wraps from last
  // to first looks identical to every other forward slide. After it lands on
  // the duplicate, we snap back to index 0 with the transition disabled —
  // invisible because both positions render the same release.
  const slides = useMemo(() => (items.length > 0 ? [...items, items[0]] : []), [items]);

  const [step, setStep] = useState(0);
  const [animate, setAnimate] = useState(true);
  // Hover-pause is read inside the interval callback. Keeping it as a ref
  // (rather than effect-dep state) avoids tearing down and recreating the
  // interval on every mouse-enter/leave, which would reset the dwell timer
  // and make rotation cadence visibly jumpy.
  const pausedRef = useRef(false);

  useEffect(() => {
    if (items.length <= 1) return;
    const id = setInterval(() => {
      if (pausedRef.current) return;
      setAnimate(true);
      setStep((s) => s + 1);
    }, ROTATION_MS);
    return () => clearInterval(id);
  }, [items.length]);

  // When we slide onto the duplicated last slot, wait for the transition to
  // finish then snap back to 0 with no animation.
  useEffect(() => {
    if (items.length <= 1) return;
    if (step !== items.length) return;
    const t = setTimeout(() => {
      setAnimate(false);
      setStep(0);
    }, TRANSITION_MS + 30);
    return () => clearTimeout(t);
  }, [step, items.length]);

  if (items.length === 0) return null;

  // Resolve the link target against the *real* current release, not the
  // duplicated wrap-around slot.
  const current = items[step % items.length].release;
  const target = chevronTarget(current);

  return (
    <section
      aria-label="Recent releases across the platform"
      className="max-w-4xl mx-auto px-6 mb-10"
      onMouseEnter={() => {
        pausedRef.current = true;
      }}
      onMouseLeave={() => {
        pausedRef.current = false;
      }}
    >
      <div className="flex items-stretch border border-stone-200 dark:border-stone-800 rounded-lg bg-white dark:bg-stone-900 overflow-hidden shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
        {/* Live pill */}
        <div className="flex items-center gap-2 px-4 bg-amber-50 dark:bg-amber-950/30 border-r border-stone-200 dark:border-stone-800 text-[11px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-300 whitespace-nowrap">
          <span className="text-amber-500 dark:text-amber-400 animate-pulse">
            <ActivityIcon />
          </span>
          <span>Recent</span>
        </div>

        {/* Sliding feed — `--row-h` keeps the translate in step with the
            row's responsive height (64px on mobile, 44px from sm: up). */}
        <div
          className="flex-1 relative overflow-hidden h-16 sm:h-11 [--row-h:64px] sm:[--row-h:44px]"
          aria-live="polite"
          aria-atomic="true"
        >
          <div
            className="absolute inset-x-0 top-0"
            style={{
              transform: `translateY(calc(${-step} * var(--row-h)))`,
              transition: animate
                ? `transform ${TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`
                : "none",
            }}
          >
            {slides.map((s, i) => (
              <Row key={`${s.release.id}-${i}`} slide={s} />
            ))}
          </div>
        </div>

        {/* External / org link — opens the original source in a new tab when
            available, otherwise drills into the org page. */}
        {target &&
          (target.external ? (
            <a
              href={target.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={target.label}
              className="flex items-center px-3 border-l border-stone-200 dark:border-stone-800 text-stone-400 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-50 dark:hover:bg-stone-800/40 transition-colors text-sm"
            >
              ↗
            </a>
          ) : (
            <Link
              href={target.href}
              aria-label={target.label}
              className="flex items-center px-3 border-l border-stone-200 dark:border-stone-800 text-stone-400 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-50 dark:hover:bg-stone-800/40 transition-colors text-sm"
            >
              ↗
            </Link>
          ))}
      </div>
    </section>
  );
}
