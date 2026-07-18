"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HomepageTickerQuery } from "@/lib/graphql/__generated__/graphql";
import { formatRelativeDate } from "@/lib/formatters";
import { videoRowInfoFromWire } from "@/lib/video-source";
import { appRowInfoFromWire } from "@/lib/app-source";
import { isRoutineAppRelease } from "@buildinternet/releases-core/importance";
import { pickReleaseThumb } from "@/lib/media";
import { OrgAvatar } from "./org-avatar";
import { AppStoreIcon } from "./app-store-icon";
import { AppPlatformCue } from "./app-platform-cue";
import { ReleaseThumb } from "./release-thumb";

export type TickerRelease = HomepageTickerQuery["latestReleases"]["items"][number];
export type Slide = { release: TickerRelease; relative: string | null; extraCount: number };

const MAX_ITEMS = 20;

// Dedup key: one slot per (org, product). Source-level orgs without a
// product collapse to a single slot per org, so a busy changelog can't
// crowd out the rest of the lineup. Multi-product orgs (Vercel → Next.js,
// Turborepo) keep one slot per product.
function dedupKey(r: TickerRelease): string {
  return `${r.source.org.slug}::${r.source.product?.slug ?? ""}`;
}

/**
 * Title-quality filter applied on top of the server's `?exclude=github`
 * filter. Drops bare-version updates where the title is just the version
 * with no human-readable context ("8.4.3", "v1.2.0", or a string that
 * collapses to nothing once the version slug is removed). The ticker is a
 * marketing surface; if there's no headline, it's not worth a slot.
 *
 * A populated `titleShort` (#852, renamed in #860) is by definition a generated
 * headline — short-circuit the bare-version filter when it's present.
 *
 * App Store updates short-circuit too: with the compact icon + app-name +
 * version treatment, a bare-version title ("5.0.0") still reads as a complete,
 * recognizable unit, so the bare-version drop doesn't apply to them. #1206
 *
 * Video releases short-circuit for the same reason: the subtle video icon
 * makes the card a complete unit even when the video title is terse. Gate on
 * the resolved provider (what `Card` actually renders), not the raw facet —
 * a truthy-but-unrecognised provider shows no icon, so it shouldn't bypass
 * the bare-version drop. #1206
 */
function isMeaningfulRelease(r: TickerRelease): boolean {
  if (r.source.appStore || videoRowInfoFromWire(r.source.video)) return true;
  if (r.titleShort?.trim() || r.titleGenerated?.trim()) return true;
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
  return r.titleShort?.trim() || r.titleGenerated?.trim() || r.title || r.version || "(untitled)";
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

// Subtle video mark for the meta row — a quiet clapper/frame glyph instead of
// a "YouTube"/"Vimeo" text chip. The provider name rides `title` + `aria-label`
// so sighted UI stays minimal while screen readers still get the platform.
function VideoIcon({ label }: { label: string }) {
  return (
    <span
      className="inline-flex shrink-0 items-center text-stone-400 dark:text-stone-500"
      title={label}
      aria-label={`Video · ${label}`}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {/* Rounded screen + play triangle — reads as “video” without a brand. */}
        <rect x="2.5" y="5.5" width="15" height="13" rx="2.5" />
        <path d="M17.5 10.5 21.5 8v8l-4-2.5" />
      </svg>
    </span>
  );
}

// Exported for render tests (`shipping-now-ticker.test.tsx`).
export function Card({ slide }: { slide: Slide }) {
  const { release, relative, extraCount } = slide;
  const video = videoRowInfoFromWire(release.source.video);
  // Mobile-app release: render the lean form — the app icon already leads the
  // header, so the body drops to an "iOS/macOS app" cue and the version chip +
  // media thumbnail are suppressed. #mobile-app-release-cards
  const app = appRowInfoFromWire(release.source.appStore, release.source.org.name);
  const thumb = app ? null : pickReleaseThumb(release.media);
  // A slot is keyed per (org, product), so a release on a specific product
  // (Google → Chrome) reads as just the org name without disambiguation. Lead
  // the header with the product name when present, dimming the org after a
  // middot — matching the "Product · Org" treatment in collection views. Skip
  // it for single-product orgs where the product name just echoes the org.
  const orgName = release.source.org.name;
  const productName = release.source.product?.name?.trim();
  const showProduct = !!productName && productName.toLowerCase() !== orgName.toLowerCase();
  return (
    <Link
      href={`/release/${release.id}`}
      data-ticker-card
      className="snap-start flex-none basis-[88%] sm:basis-[calc(33.333%-0.5rem)] lg:basis-[calc(25%-0.5625rem)] flex flex-col gap-2 p-4 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 hover:border-stone-300 dark:hover:border-stone-700 hover:shadow-sm transition-[border-color,box-shadow] shadow-[0_1px_2px_rgba(0,0,0,0.02)]"
    >
      {/* Attribution row only — keep the relative timestamp here, never the
          media thumb (it used to sit next to "5h ago" and felt cramped). */}
      <div className="flex items-center gap-2 min-w-0">
        {/* App Store releases lead with the app icon (more recognizable than
            the org avatar for an app update); everything else uses the org
            avatar. #1206 */}
        {release.source.appStore?.iconUrl ? (
          <AppStoreIcon
            iconUrl={release.source.appStore.iconUrl}
            appName={release.source.org.name}
            size={18}
          />
        ) : release.source.org.avatarUrl ? (
          <OrgAvatar
            avatarUrl={release.source.org.avatarUrl}
            githubHandle={null}
            name={release.source.org.name}
            size={18}
          />
        ) : null}
        <span className="font-medium text-[13px] text-stone-900 dark:text-stone-100 truncate flex-1">
          {showProduct ? (
            <>
              {productName}
              <span className="font-normal text-stone-400 dark:text-stone-500">
                {" · "}
                {orgName}
              </span>
            </>
          ) : (
            orgName
          )}
        </span>
        {relative && (
          <span className="font-mono text-[11px] text-stone-400 dark:text-stone-500 whitespace-nowrap">
            {relative}
          </span>
        )}
      </div>
      {/* Title + optional media: thumb rides the content row (right, top-
          aligned), same as related-rail cards — not the header chrome. For a
          mobile-app release the body is the muted platform cue instead of the
          (usually boilerplate) release title. */}
      <div className="flex items-start gap-3 min-w-0">
        <p className="flex-1 min-w-0 text-[13px] text-stone-700 dark:text-stone-300 line-clamp-3 leading-5 min-h-[2.5rem]">
          {app ? <AppPlatformCue label={app.label} /> : pickLabel(release)}
        </p>
        {thumb && <ReleaseThumb src={thumb.url} alt={thumb.alt} size="md" />}
      </div>
      <div className="flex items-center gap-2 min-w-0">
        {/* Video releases get a quiet icon (not a "YouTube" text chip); version
            still follows when present. #1206. App releases drop the version
            chip — it carries no meaning for a routine app update. */}
        {video && <VideoIcon label={video.label} />}
        {!app && release.version && (
          <span className="font-mono text-[11px] text-stone-500 dark:text-stone-400 bg-stone-100 dark:bg-stone-800 px-1.5 py-0.5 rounded whitespace-nowrap max-w-full truncate">
            {release.version}
          </span>
        )}
        {extraCount > 0 && (
          <span
            className="text-[11px] text-stone-500 dark:text-stone-400 whitespace-nowrap ml-auto"
            title={`${extraCount} more recent release${extraCount === 1 ? "" : "s"} from ${showProduct ? productName : orgName}`}
          >
            +{extraCount} more
          </span>
        )}
      </div>
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
  const items = useMemo<Slide[]>(() => {
    const slots = new Map<string, Slide>();
    for (const release of releases) {
      if (!isMeaningfulRelease(release)) continue;
      // Cross-promo deprioritization: this platform-wide rail drops routine
      // (low-importance / unscored) mobile-app updates; notable app releases and
      // all non-app releases stay. Same rule as the server related rail.
      // #mobile-app-release-cards
      if (isRoutineAppRelease(!!release.source.appStore, release.importance)) continue;
      const existing = slots.get(dedupKey(release));
      if (existing) {
        existing.extraCount += 1;
      } else {
        slots.set(dedupKey(release), {
          release,
          extraCount: 0,
          relative: release.publishedAt ? formatRelativeDate(release.publishedAt) : null,
        });
      }
    }
    return Array.from(slots.values()).slice(0, MAX_ITEMS);
  }, [releases]);

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
    <section
      aria-label="Recent releases across the platform"
      className="max-w-[1240px] mx-auto px-6 mb-10"
    >
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center gap-2 mb-3">
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
                className="flex h-8 w-8 items-center justify-center rounded-md border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 hover:border-stone-300 dark:hover:border-stone-700 disabled:opacity-30 disabled:pointer-events-none transition-[color,border-color,transform] active:scale-[0.96]"
              >
                <ChevronIcon direction="left" />
              </button>
              <button
                type="button"
                onClick={() => scrollByCard(1)}
                disabled={!canNext}
                aria-label="Scroll to next releases"
                className="flex h-8 w-8 items-center justify-center rounded-md border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 hover:border-stone-300 dark:hover:border-stone-700 disabled:opacity-30 disabled:pointer-events-none transition-[color,border-color,transform] active:scale-[0.96]"
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
          className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-2 -mb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {items.map((slide) => (
            <Card key={slide.release.id} slide={slide} />
          ))}
        </div>
      </div>
    </section>
  );
}
