"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import Link from "next/link";
import { EXTERNAL_UGC_REL } from "@/lib/sanitize";
import { OrgAvatar } from "./org-avatar";
import { GifVideo } from "./gif-video";
import { MEDIA_VIDEO_ON, shouldRenderAsVideo } from "@/lib/media";

/**
 * One previewable image in the feed. Built by whoever renders the thumbnail
 * (see {@link useLightboxImage}); the provider collects them so the overlay can
 * page left/right between every image currently on the page, in visual order.
 */
export interface LightboxEntry {
  /** Stable id, unique per image (`${rowId}:thumb`, `${rowId}:g0`, …). */
  id: string;
  src: string;
  alt: string;
  /** Release context surfaced in the overlay header (lost once zoomed in). */
  title: string;
  dateLabel: string | null;
  /** Product/org/source name — the "where did this come from" line. */
  byline: string | null;
  /** Org avatar shown next to the byline (already resolved, incl. GitHub
   *  fallback); null falls back to an initial-letter chip. */
  avatarUrl: string | null;
  /** On-site release detail page (`/release/{id}`), when the row has an id. */
  detailHref: string | null;
  /** Original external source, when known. */
  sourceUrl: string | null;
  /** Viewport rect of the thumbnail, read at open-time to order the set. */
  getRect: () => DOMRect | null;
}

interface LightboxContextValue {
  register: (entry: LightboxEntry) => () => void;
  open: (id: string) => void;
}

const NOOP: LightboxContextValue = { register: () => () => {}, open: () => {} };
const LightboxContext = createContext<LightboxContextValue>(NOOP);

export function useLightbox(): LightboxContextValue {
  return useContext(LightboxContext);
}

/**
 * Register a thumbnail with the page-level lightbox and get back a ref to wire
 * onto the clickable element (used both for click-to-open and for ordering the
 * paging set by on-screen position) plus an `open()` to call on click.
 */
export function useLightboxImage<T extends HTMLElement>(entry: Omit<LightboxEntry, "getRect">) {
  const { register, open } = useLightbox();
  const ref = useRef<T | null>(null);
  const { id, src, alt, title, dateLabel, byline, avatarUrl, detailHref, sourceUrl } = entry;
  useEffect(() => {
    // Rows without a previewable image (app-store/video rows, or no media) pass
    // an empty src — don't register a ghost entry that paging could land on.
    if (!src) return;
    return register({
      id,
      src,
      alt,
      title,
      dateLabel,
      byline,
      avatarUrl,
      detailHref,
      sourceUrl,
      getRect: () => ref.current?.getBoundingClientRect() ?? null,
    });
  }, [register, id, src, alt, title, dateLabel, byline, avatarUrl, detailHref, sourceUrl]);
  const openThis = useCallback(() => open(id), [open, id]);
  return { ref: ref as RefObject<T | null>, open: openThis };
}

export function LightboxProvider({ children }: { children: ReactNode }) {
  const entriesRef = useRef<Map<string, LightboxEntry>>(new Map());
  const [view, setView] = useState<{ list: LightboxEntry[]; index: number } | null>(null);

  const register = useCallback((entry: LightboxEntry) => {
    entriesRef.current.set(entry.id, entry);
    return () => {
      entriesRef.current.delete(entry.id);
    };
  }, []);

  const open = useCallback((id: string) => {
    // Snapshot the set in visual order (top-to-bottom, then left-to-right) so
    // left/right paging follows the feed rather than registration order.
    const list = [...entriesRef.current.values()]
      .map((e) => ({ e, rect: e.getRect() }))
      .filter((x): x is { e: LightboxEntry; rect: DOMRect } => x.rect != null)
      .toSorted((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
      .map((x) => x.e);
    const index = list.findIndex((e) => e.id === id);
    if (index < 0) return;
    setView({ list, index });
  }, []);

  const close = useCallback(() => setView(null), []);
  const go = useCallback((delta: number) => {
    setView((v) => {
      if (!v) return v;
      const next = v.index + delta;
      if (next < 0 || next >= v.list.length) return v;
      return { list: v.list, index: next };
    });
  }, []);

  const ctx = useMemo(() => ({ register, open }), [register, open]);

  return (
    <LightboxContext.Provider value={ctx}>
      {children}
      {view && <LightboxOverlay view={view} go={go} onClose={close} />}
    </LightboxContext.Provider>
  );
}

const arrowRight = (
  <svg
    className="h-3.5 w-3.5"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    aria-hidden="true"
  >
    <path d="M3 8h9M9 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const externalIcon = (
  <svg
    className="h-3 w-3"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    aria-hidden="true"
  >
    <path
      d="M9 3h4v4M13 3 7.5 8.5M12.5 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1h2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

function NavButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={side === "left" ? "Previous image" : "Next image"}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`absolute top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white/80 ring-1 ring-inset ring-white/15 backdrop-blur-sm transition-colors hover:bg-white/20 hover:text-white ${
        side === "left" ? "left-2 sm:left-4" : "right-2 sm:right-4"
      }`}
    >
      <svg
        className="h-5 w-5"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        aria-hidden="true"
      >
        <path
          d={side === "left" ? "M10 3 5 8l5 5" : "M6 3l5 5-5 5"}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/**
 * Image preview overlay, modelled on file-preview surfaces like Google Drive /
 * Box: a detail header bar across the top (held to the app's content column)
 * with the image floating large but capped on the dark scrim below — no card,
 * no white background. Left/right (keys or the edge buttons) page between every
 * image on the page. Clicking the scrim, or Escape, closes; the header and
 * image swallow clicks so neither dismisses.
 */
function LightboxOverlay({
  view,
  go,
  onClose,
}: {
  view: { list: LightboxEntry[]; index: number };
  go: (delta: number) => void;
  onClose: () => void;
}) {
  const { list, index } = view;
  const hasPrev = index > 0;
  const hasNext = index < list.length - 1;
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const [erroredSrc, setErroredSrc] = useState<string | null>(null);

  useEffect(() => {
    // Move focus into the dialog and restore it to the opener on close, so
    // keyboard users aren't dropped back at the top of the page (a11y).
    const opener = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "Tab") {
        // Trap focus within the dialog.
        const focusable = Array.from(
          dialogRef.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? [],
        ).filter((el) => el.offsetParent !== null);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, [onClose, go]);

  const { src, alt, title, dateLabel, byline, avatarUrl, detailHref, sourceUrl } = list[index];
  const imageFailed = erroredSrc === src;
  const asVideo = shouldRenderAsVideo({ src, enabled: MEDIA_VIDEO_ON });
  const primaryIsExternal = !detailHref && !!sourceUrl;
  const primaryHref = detailHref ?? sourceUrl;
  const primaryLabel = detailHref ? "View full release" : "View source";
  // A secondary "original source" link only when the primary is the on-site
  // detail page — otherwise the primary already points at the source.
  const showSourceLink = !!detailHref && !!sourceUrl;

  const ctaClasses =
    "inline-flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-[13px] font-medium text-white ring-1 ring-inset ring-white/15 hover:bg-white/20 transition-colors whitespace-nowrap";

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={title || alt || "Image preview"}
      onClick={onClose}
      className="lightbox-backdrop fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm cursor-zoom-out"
    >
      {/* Detail bar — held to the same centered content column the app uses
          (max-w-5xl px-6) so the title/byline line up with the feed. */}
      <div onClick={(e) => e.stopPropagation()} className="shrink-0 cursor-default pt-4 pb-3">
        <div className="mx-auto flex w-full max-w-5xl items-start justify-between gap-4 px-6">
          <div className="min-w-0">
            <h2 className="m-0 truncate text-[15px] font-semibold leading-snug text-white">
              {title}
            </h2>
            <div className="mt-1 flex items-center text-[12px] text-white/60">
              {byline && (
                <span className="flex min-w-0 items-center gap-1.5">
                  <OrgAvatar avatarUrl={avatarUrl} githubHandle={null} name={byline} size={16} />
                  <span className="truncate">{byline}</span>
                </span>
              )}
              {byline && dateLabel && <span className="px-1.5 text-white/30">·</span>}
              {dateLabel && <span className="shrink-0 tabular-nums">{dateLabel}</span>}
              {list.length > 1 && (
                <span className="ml-2 shrink-0 tabular-nums text-white/30">
                  {index + 1} / {list.length}
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {showSourceLink && (
              <a
                href={sourceUrl!}
                target="_blank"
                rel={EXTERNAL_UGC_REL}
                className="hidden items-center gap-1 text-[13px] text-white/60 underline-offset-2 hover:text-white/90 hover:underline sm:inline-flex"
              >
                Source
                {externalIcon}
              </a>
            )}
            {primaryHref &&
              (primaryIsExternal ? (
                <a href={primaryHref} target="_blank" rel={EXTERNAL_UGC_REL} className={ctaClasses}>
                  {primaryLabel}
                  {externalIcon}
                </a>
              ) : (
                <Link href={primaryHref} className={ctaClasses}>
                  {primaryLabel}
                  {arrowRight}
                </Link>
              ))}
            <button
              ref={closeBtnRef}
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-full text-2xl leading-none text-white/70 hover:bg-white/10 hover:text-white"
            >
              ×
            </button>
          </div>
        </div>
      </div>
      {/* Image — floats on the scrim, centered in the same column and capped so
          a high-res original doesn't upscale to fill the viewport. A broken src
          falls back to a placeholder instead of the browser's broken-image icon. */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 pb-6 sm:px-6">
        {asVideo ? (
          // GifVideo carries its own <img> fallback on transform error, so it
          // sits outside the imageFailed placeholder branch.
          <GifVideo
            src={src}
            alt={alt}
            onClick={(e) => e.stopPropagation()}
            className="lightbox-card h-auto max-h-full w-auto max-w-5xl cursor-default rounded-md object-contain shadow-2xl ring-1 ring-white/10"
          />
        ) : imageFailed ? (
          <div
            onClick={(e) => e.stopPropagation()}
            className="lightbox-card flex cursor-default items-center justify-center rounded-md px-10 py-16 text-[13px] text-white/50 ring-1 ring-white/10"
          >
            Image unavailable
          </div>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={src}
            alt={alt}
            onClick={(e) => e.stopPropagation()}
            onError={() => setErroredSrc(src)}
            className="lightbox-card h-auto max-h-full w-auto max-w-5xl cursor-default rounded-md object-contain shadow-2xl ring-1 ring-white/10"
          />
        )}
      </div>
      {hasPrev && <NavButton side="left" onClick={() => go(-1)} />}
      {hasNext && <NavButton side="right" onClick={() => go(1)} />}
    </div>
  );
}
