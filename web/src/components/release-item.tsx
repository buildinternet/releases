"use client";

import { useState, useMemo, useId, ViewTransition } from "react";
import ReactMarkdown from "react-markdown";
import { remarkPlugins } from "@/lib/markdown-plugins";
import { rehypeShikiPlugin } from "@/lib/shiki";
import Link from "next/link";
import type { ReleaseItem } from "@/lib/api";
import { FallbackImage } from "./fallback-image";
import { GifVideo } from "./gif-video";
import {
  releaseThumbUrl,
  IMG_TRANSFORM_ON,
  MEDIA_VIDEO_ON,
  shouldRenderAsVideo,
} from "@/lib/media";
import { appStoreIconUrl, type AppRowInfo } from "@/lib/app-source";
import type { VideoRowInfo } from "@/lib/video-source";
import { EXTERNAL_UGC_REL } from "@/lib/sanitize";
import { deriveFeedTitle } from "@/lib/release-title";
import { releaseExcerpt } from "@/lib/release-excerpt";
import { feedAttachments } from "@/lib/feed-media";
import { markdownComponents, collapsedMarkdownComponents } from "./markdown-components";
import { rewriteRelativeLinks, originFromUrl } from "@releases/rendering/rewrite-links";
import { formatDate } from "@/lib/formatters";
import { RollupBadge } from "./rollup-badge";
import { ClusterChip } from "./cluster-chip";
import { CompactComposition } from "./compact-composition";
import { PlayBadge } from "./play-badge";
import { useLightboxImage, type LightboxEntry } from "./lightbox";

/** Release context shared by every previewable image in one feed row. */
type RowMeta = Pick<
  LightboxEntry,
  "title" | "dateLabel" | "byline" | "avatarUrl" | "detailHref" | "sourceUrl"
>;

type FeedMediaItem = NonNullable<ReleaseItem["media"]>[number];

const CHIP_THUMB_PX = 56;
const CHIP_BUTTON_CLASS =
  "h-14 w-14 shrink-0 overflow-hidden rounded-md border border-stone-200 bg-stone-50 transition-colors hover:border-stone-300 dark:border-stone-700 dark:bg-stone-900 dark:hover:border-stone-600 cursor-zoom-in";
const SIDE_IMAGE_CLASS =
  "rounded-md object-cover w-[120px] h-[72px] border border-stone-200 dark:border-stone-800";

function mediaSrc(item: FeedMediaItem) {
  return item.r2Url ?? item.url;
}

/** Clickable feed thumbnail — side-rail preview (single attachment) or chip (gallery). */
function FeedMediaThumb({
  id,
  item,
  meta,
  variant,
}: {
  id: string;
  item: FeedMediaItem;
  meta: RowMeta;
  variant: "side" | "chip";
}) {
  const src = mediaSrc(item);
  const alt = item.alt || "";
  const { ref, open } = useLightboxImage<HTMLButtonElement>({ id, src, alt, ...meta });
  const isChip = variant === "chip";

  return (
    <button
      ref={ref}
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        open();
      }}
      className={isChip ? CHIP_BUTTON_CLASS : "shrink-0 cursor-zoom-in"}
      aria-label={alt ? `Preview image: ${alt}` : "Preview image"}
    >
      {shouldRenderAsVideo({ type: item.type, src, enabled: MEDIA_VIDEO_ON }) ? (
        <GifVideo
          src={src}
          alt={alt}
          className={isChip ? "h-full w-full object-cover" : SIDE_IMAGE_CLASS}
        />
      ) : (
        <FallbackImage
          src={releaseThumbUrl(src, isChip ? CHIP_THUMB_PX * 2 : 240)}
          alt={alt}
          width={isChip ? CHIP_THUMB_PX : 120}
          height={isChip ? CHIP_THUMB_PX : 72}
          className={isChip ? "h-full w-full object-cover" : SIDE_IMAGE_CLASS}
          unoptimized={IMG_TRANSFORM_ON || undefined}
        />
      )}
    </button>
  );
}

const markdownClasses =
  "prose prose-sm prose-stone dark:prose-invert max-w-none text-[13px] leading-relaxed [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:mt-2 [&_h1]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:mt-1.5 [&_h3]:mb-0.5 [&_ul]:my-1 [&_ul]:pl-4 [&_li]:my-0 [&_p]:my-1 [&_a]:text-stone-600 dark:[&_a]:text-stone-400 [&_a]:no-underline [&_code]:text-[13px] [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none";

export function ReleaseListItem({
  release,
  hideDate,
  sourceByline,
  appStore,
  video,
  byline,
  avatarUrl,
}: {
  release: ReleaseItem;
  hideDate?: boolean;
  sourceByline?: { name: string; slug: string; orgSlug?: string };
  appStore?: AppRowInfo | null;
  video?: VideoRowInfo | null;
  /** Product/org/source label for the lightbox byline — the originating
   *  product or source name, supplied by the feed container. */
  byline?: string;
  /** Resolved org avatar URL (incl. GitHub fallback) for the lightbox byline. */
  avatarUrl?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const rowId = useId();
  const markdownContent = useMemo(() => {
    // Feed surfaces show an excerpt only; the full verbatim body lives on the
    // self-canonical /release/{id} page (#1606).
    const raw = releaseExcerpt(release);
    const base = originFromUrl(release.url);
    return base ? rewriteRelativeLinks(raw, base) : raw;
  }, [release.content, release.summary, release.title, release.url]);

  const thumbnail = useMemo(
    () => release.media?.find((m) => m.type === "image" || m.type === "gif") ?? null,
    [release.media],
  );

  const attachments = useMemo(
    () => feedAttachments(release.media, markdownContent),
    [release.media, markdownContent],
  );

  // Video rows: the thumbnail + play badge link out to the source video (the
  // play affordance should play, not toggle the row). Defined once so the
  // linked and (url-less) plain variants don't duplicate the image markup.
  const videoThumbnailInner =
    video && thumbnail ? (
      <>
        <FallbackImage
          src={releaseThumbUrl(thumbnail.r2Url ?? thumbnail.url, 320)}
          alt={thumbnail.alt || ""}
          width={160}
          height={90}
          className="rounded-md object-cover w-[160px] h-[90px] border border-stone-200 dark:border-stone-800"
          unoptimized={IMG_TRANSFORM_ON || undefined}
        />
        <PlayBadge size="sm" />
      </>
    ) : null;

  // Feed title hierarchy (#feed-title): lead with a descriptive headline and
  // demote the version, instead of using a bare `v2.1.154` (which loses product
  // context). When the row has nothing more descriptive than its version, fall
  // back to a product+version headline. The product/source name is shown only
  // when the feed mixes sources (`sourceByline` is set) — folding the old
  // left-rail byline into an inline meta line. App Store rows keep their own
  // layout below. See `.context/2026-05-29-feed-version-title-hierarchy.md`.
  const { descriptive, versionLabel } = deriveFeedTitle(release);

  // Context shown alongside the image in the lightbox so a zoomed-in screenshot
  // still says which release it belongs to: title, org avatar + name byline, and
  // links to the on-site detail page (primary) and the original source (secondary).
  const lightboxMeta: RowMeta = {
    title: descriptive || versionLabel || release.title || "Release",
    dateLabel: release.publishedAt ? formatDate(release.publishedAt) : null,
    byline: byline ?? sourceByline?.name ?? appStore?.appName ?? video?.label ?? null,
    avatarUrl: avatarUrl ?? null,
    detailHref: release.id ? `/release/${release.id}` : null,
    sourceUrl: release.url ?? null,
  };

  // One non-inline attachment keeps the side-rail preview; two+ use a bottom chip row.
  const sideThumb = !appStore && !video && attachments.length === 1 ? attachments[0] : null;

  // Bold heading: the descriptive title when we have one; otherwise the version,
  // led by the product name (with the version dimmed after it, matching the App
  // Store row pattern) on multi-source feeds, or standing alone on a single-
  // source page whose header already names the product. `release.title` is the
  // last-resort fallback for the degenerate empty-title, no-version row.
  const headingInner = descriptive ? (
    descriptive
  ) : versionLabel ? (
    sourceByline ? (
      <>
        {sourceByline.name}{" "}
        <span className="font-normal text-stone-500 dark:text-stone-400">{versionLabel}</span>
      </>
    ) : (
      versionLabel
    )
  ) : (
    release.title
  );

  // Demoted meta line under a descriptive heading: the source name (linked,
  // multi-source feeds only) and the version, joined by a dot. The version shows
  // only when it isn't already in the version-fallback heading.
  const showMetaVersion = !!descriptive && !!versionLabel;
  const showMetaName = !!sourceByline && (!!descriptive || !versionLabel);

  const titleId = release.id ? `rel-${release.id}-title` : undefined;
  const headingClasses = "font-semibold text-[15px] text-stone-900 dark:text-stone-100 m-0";

  return (
    <article
      className="group/item flex gap-0 relative"
      {...(titleId ? { "aria-labelledby": titleId } : {})}
    >
      {/* Left rail: date + source byline + timeline */}
      <div className="w-[100px] shrink-0 relative flex flex-col items-end pr-5 pt-5 gap-1">
        {!hideDate && (
          <time
            dateTime={release.publishedAt ?? undefined}
            className="text-[12px] text-stone-400 dark:text-stone-500 whitespace-nowrap tabular-nums"
          >
            {formatDate(release.publishedAt)}
          </time>
        )}
        {/* Dot on timeline */}
        <div className="absolute right-0 top-[22px] w-[7px] h-[7px] rounded-full bg-stone-300 dark:bg-stone-600 translate-x-[3px] z-10" />
      </div>
      {/* Timeline line */}
      <div className="absolute left-[100px] top-0 bottom-0 w-px bg-stone-200 dark:bg-stone-800" />
      {/* Content */}
      <div className="flex-1 min-w-0 border-b border-stone-200 dark:border-stone-800 last:border-b-0 py-4 pl-5">
        {appStore && (
          <div
            className="group relative cursor-pointer"
            role="button"
            tabIndex={0}
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse release notes" : "Expand release notes"}
            onClick={() => setExpanded(!expanded)}
            onKeyDown={(e) => {
              // Only toggle when the wrapper itself is focused — don't hijack
              // Enter/Space on nested links (source link, App Store link, notes).
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setExpanded(!expanded);
              }
            }}
          >
            <div className="flex items-center gap-3">
              {appStore.iconUrl ? (
                <FallbackImage
                  src={appStoreIconUrl(appStore.iconUrl, 96)}
                  alt=""
                  width={36}
                  height={36}
                  className="rounded-[9px] border border-stone-200 dark:border-stone-800 shrink-0"
                />
              ) : (
                <div className="w-9 h-9 rounded-[9px] bg-stone-200 dark:bg-stone-700 flex items-center justify-center text-stone-500 dark:text-stone-300 font-semibold shrink-0">
                  {appStore.appName.charAt(0)}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <h2 id={titleId} className={headingClasses}>
                    {release.id ? (
                      <Link
                        href={`/release/${release.id}`}
                        className="hover:underline underline-offset-2"
                      >
                        {appStore.appName}
                        {release.version && (
                          <span className="ml-1.5 font-normal text-stone-500 dark:text-stone-400">
                            v{release.version}
                          </span>
                        )}
                      </Link>
                    ) : (
                      <>
                        {appStore.appName}
                        {release.version && (
                          <span className="ml-1.5 font-normal text-stone-500 dark:text-stone-400">
                            v{release.version}
                          </span>
                        )}
                      </>
                    )}
                  </h2>
                  {release.url && (
                    <a
                      href={release.url}
                      target="_blank"
                      rel={EXTERNAL_UGC_REL}
                      aria-label="Open original source"
                      onClick={(e) => e.stopPropagation()}
                      className="text-stone-400 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 text-xs"
                    >
                      ↗
                    </a>
                  )}
                </div>
                <div className="text-[13px] text-stone-500 dark:text-stone-400">
                  Available for {appStore.label}
                </div>
              </div>
              <svg
                className={`ml-auto shrink-0 h-4 w-4 text-stone-400 dark:text-stone-500 transition-transform ${
                  expanded ? "rotate-180" : ""
                }`}
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            {expanded && (
              <div className="mt-2 pl-12">
                {markdownContent.trim() ? (
                  <div className={markdownClasses}>
                    <ReactMarkdown
                      remarkPlugins={remarkPlugins}
                      rehypePlugins={[rehypeShikiPlugin]}
                      components={markdownComponents}
                    >
                      {markdownContent}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-[13px] italic text-stone-400 dark:text-stone-500 m-0">
                    No release notes provided.
                  </p>
                )}
                {release.url && (
                  <a
                    href={release.url}
                    target="_blank"
                    rel={EXTERNAL_UGC_REL}
                    onClick={(e) => e.stopPropagation()}
                    className="inline-block mt-2 text-[12px] text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300"
                  >
                    View on the App Store ↗
                  </a>
                )}
              </div>
            )}
          </div>
        )}
        {video && !appStore && (
          <div
            className="group relative cursor-pointer"
            role="button"
            tabIndex={0}
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse release notes" : "Expand release notes"}
            onClick={() => setExpanded(!expanded)}
            onKeyDown={(e) => {
              // Only toggle when the wrapper itself is focused — don't hijack
              // Enter/Space on nested links (watch link, notes).
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setExpanded(!expanded);
              }
            }}
          >
            <div className="flex items-start gap-3">
              {thumbnail &&
                (release.url ? (
                  <a
                    href={release.url}
                    target="_blank"
                    rel={EXTERNAL_UGC_REL}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Watch on ${video.label}`}
                    className="group relative shrink-0"
                  >
                    {videoThumbnailInner}
                  </a>
                ) : (
                  <div className="relative shrink-0">{videoThumbnailInner}</div>
                ))}
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className={headingClasses}>
                  {release.id ? (
                    <Link
                      href={`/release/${release.id}`}
                      className="hover:underline underline-offset-2"
                    >
                      {headingInner}
                    </Link>
                  ) : (
                    headingInner
                  )}
                </h2>
                <div className="text-[13px] text-stone-500 dark:text-stone-400">
                  Watch on {video.label}
                </div>
              </div>
              <svg
                className={`ml-auto shrink-0 h-4 w-4 text-stone-400 dark:text-stone-500 transition-transform ${
                  expanded ? "rotate-180" : ""
                }`}
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            {expanded && (
              <div className={`mt-2 ${thumbnail ? "pl-[172px]" : ""}`}>
                {markdownContent.trim() ? (
                  <div className={markdownClasses}>
                    <ReactMarkdown
                      remarkPlugins={remarkPlugins}
                      rehypePlugins={[rehypeShikiPlugin]}
                      components={markdownComponents}
                    >
                      {markdownContent}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-[13px] italic text-stone-400 dark:text-stone-500 m-0">
                    No description provided.
                  </p>
                )}
                {release.url && (
                  <a
                    href={release.url}
                    target="_blank"
                    rel={EXTERNAL_UGC_REL}
                    onClick={(e) => e.stopPropagation()}
                    className="inline-block mt-2 text-[12px] text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300"
                  >
                    Watch on {video.label}
                  </a>
                )}
              </div>
            )}
          </div>
        )}
        {!appStore && !video && (
          <>
            <div className="flex items-baseline gap-1.5 mb-1">
              <h2 id={titleId} className={headingClasses}>
                {release.id ? (
                  <ViewTransition name={`rel-${release.id}`} default="none">
                    <Link
                      href={`/release/${release.id}`}
                      className="hover:underline underline-offset-2"
                    >
                      {headingInner}
                    </Link>
                  </ViewTransition>
                ) : (
                  headingInner
                )}
              </h2>
              {release.url && (
                <a
                  href={release.url}
                  target="_blank"
                  rel={EXTERNAL_UGC_REL}
                  aria-label="Open original source"
                  className="text-stone-400 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 text-xs inline-flex items-center justify-center w-7 h-7 -my-2 -mx-1 rounded"
                >
                  ↗
                </a>
              )}
              <RollupBadge type={release.type} />
              <ClusterChip count={release.coverageCount} />
              {release.prerelease && (
                <span
                  title="Pre-release (beta, rc, nightly, preview)"
                  className="text-[10px] uppercase tracking-wide text-stone-500 dark:text-stone-400 bg-stone-100 dark:bg-stone-800 rounded px-1.5 py-0.5 leading-none"
                >
                  pre
                </span>
              )}
              <CompactComposition
                composition={release.composition}
                className="ml-auto self-center"
              />
            </div>
            {(showMetaName || showMetaVersion) && (
              <div className="text-sm text-stone-600 dark:text-stone-400 mb-1">
                {showMetaName &&
                  sourceByline &&
                  (sourceByline.orgSlug ? (
                    <Link
                      href={`/${sourceByline.orgSlug}/${sourceByline.slug}`}
                      className="hover:text-stone-700 dark:hover:text-stone-300"
                    >
                      {sourceByline.name}
                    </Link>
                  ) : (
                    sourceByline.name
                  ))}
                {showMetaName && showMetaVersion && (
                  <span className="text-stone-400 dark:text-stone-600"> · </span>
                )}
                {showMetaVersion && versionLabel}
              </div>
            )}
            <div className="relative">
              <div className={sideThumb ? "flex gap-3" : undefined}>
                <div className={sideThumb ? "flex-1 min-w-0" : undefined}>
                  {markdownContent.trim() ? (
                    <div
                      className={`${markdownClasses} text-stone-500 dark:text-stone-400 [&_strong]:text-stone-500 dark:[&_strong]:text-stone-400`}
                    >
                      <ReactMarkdown
                        remarkPlugins={remarkPlugins}
                        rehypePlugins={[rehypeShikiPlugin]}
                        components={collapsedMarkdownComponents}
                      >
                        {markdownContent}
                      </ReactMarkdown>
                    </div>
                  ) : null}
                </div>
                {sideThumb && (
                  <FeedMediaThumb
                    id={`${rowId}:thumb`}
                    item={sideThumb}
                    meta={lightboxMeta}
                    variant="side"
                  />
                )}
              </div>
              {attachments.length > 1 && (
                <div
                  role="group"
                  aria-label="Attachments"
                  className="mt-2.5 flex flex-wrap gap-1.5"
                >
                  {attachments.map((item, i) => (
                    <FeedMediaThumb
                      key={i}
                      id={`${rowId}:g${i}`}
                      item={item}
                      meta={lightboxMeta}
                      variant="chip"
                    />
                  ))}
                </div>
              )}
              {release.id && markdownContent.trim() && (
                <Link
                  href={`/release/${release.id}`}
                  className="inline-block mt-2 text-[12px] text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300"
                >
                  Read more →
                </Link>
              )}
            </div>
          </>
        )}
      </div>
    </article>
  );
}
