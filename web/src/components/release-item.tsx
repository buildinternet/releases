"use client";

import { useState, useRef, useEffect, useMemo, ViewTransition } from "react";
import ReactMarkdown from "react-markdown";
import { remarkPlugins } from "@/lib/markdown-plugins";
import { rehypeShikiPlugin } from "@/lib/shiki";
import Link from "next/link";
import type { ReleaseItem } from "@/lib/api";
import Image from "next/image";
import { FallbackImage } from "./fallback-image";
import { releaseThumbUrl, IMG_TRANSFORM_ON } from "@/lib/media";
import { appStoreIconUrl, type AppRowInfo } from "@/lib/app-source";
import type { VideoRowInfo } from "@/lib/video-source";
import { EXTERNAL_UGC_REL, isOptimizableImage } from "@/lib/sanitize";
import { deriveFeedTitle } from "@/lib/release-title";
import { markdownComponents, collapsedMarkdownComponents } from "./markdown-components";
import { formatDate } from "@/lib/formatters";
import { RollupBadge } from "./rollup-badge";
import { ClusterChip } from "./cluster-chip";
import { CompactComposition } from "./compact-composition";

/** Strip a leading markdown heading that duplicates the release title,
 *  and empty artifacts left by HTML-to-markdown conversion. */
function stripLeadingTitle(content: string, title: string | null): string {
  if (!title || !content) return content;
  const firstNewline = content.indexOf("\n");
  if (firstNewline === -1) return content;
  const firstLine = content
    .slice(0, firstNewline)
    .replace(/^#+\s+/, "")
    .trim();
  if (firstLine.toLowerCase() === title.toLowerCase()) {
    content = content.slice(firstNewline + 1).trimStart();
  }
  // Strip empty markdown artifacts (orphan list items, empty headings)
  content = content.replace(/^(?:-\s*\n|#+\s*\n)+/, "");
  return content;
}

function MediaGallery({
  media,
  content,
  onPreview,
}: {
  media: ReleaseItem["media"];
  content: string;
  onPreview: (src: string, alt: string) => void;
}) {
  if (!media || media.length === 0) return null;

  // Filter out items already rendered inline via markdown content.
  // Content URLs may be rewritten from original to R2 paths, so check both.
  const extra = media.filter(
    (m) => !content.includes(m.url) && !(m.r2Url && content.includes(m.r2Url)),
  );
  if (extra.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {extra.map((item, i) => {
        if (item.type === "image" || item.type === "gif") {
          const src = item.r2Url ?? item.url;
          return (
            <button
              key={i}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onPreview(src, item.alt || "");
              }}
              className="cursor-zoom-in"
              aria-label="Preview image"
            >
              <FallbackImage
                src={releaseThumbUrl(src, 800)}
                alt={item.alt || ""}
                width={400}
                height={192}
                className="rounded-md object-contain max-h-48 w-auto"
                unoptimized={IMG_TRANSFORM_ON || undefined}
              />
            </button>
          );
        }
        return null;
      })}
    </div>
  );
}

function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt || "Image preview"}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 cursor-zoom-out"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full h-full flex items-center justify-center cursor-default"
      >
        <Image
          src={src}
          alt={alt}
          fill
          sizes="100vw"
          quality={90}
          unoptimized={!isOptimizableImage(src)}
          className="object-contain rounded-md shadow-2xl"
        />
      </div>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute top-4 right-4 text-white/70 hover:text-white text-2xl leading-none w-8 h-8 flex items-center justify-center rounded-full bg-black/30 hover:bg-black/50"
      >
        ×
      </button>
    </div>
  );
}

const COLLAPSED_MAX_HEIGHT = 72; // ~4.5em at 16px

const markdownClasses =
  "prose prose-sm prose-stone dark:prose-invert max-w-none text-[13px] leading-relaxed [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:mt-2 [&_h1]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:mt-1.5 [&_h3]:mb-0.5 [&_ul]:my-1 [&_ul]:pl-4 [&_li]:my-0 [&_p]:my-1 [&_a]:text-stone-600 dark:[&_a]:text-stone-400 [&_a]:no-underline [&_code]:text-[13px] [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none";

export function ReleaseListItem({
  release,
  hideDate,
  sourceByline,
  appStore,
  video,
}: {
  release: ReleaseItem;
  hideDate?: boolean;
  sourceByline?: { name: string; slug: string; orgSlug?: string };
  appStore?: AppRowInfo | null;
  video?: VideoRowInfo | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const markdownContent = useMemo(
    () => stripLeadingTitle(release.content || release.summary, release.title),
    [release.content, release.summary, release.title],
  );

  const thumbnail = useMemo(
    () => release.media?.find((m) => m.type === "image" || m.type === "gif") ?? null,
    [release.media],
  );

  // Feed title hierarchy (#feed-title): lead with a descriptive headline and
  // demote the version, instead of using a bare `v2.1.154` (which loses product
  // context). When the row has nothing more descriptive than its version, fall
  // back to a product+version headline. The product/source name is shown only
  // when the feed mixes sources (`sourceByline` is set) — folding the old
  // left-rail byline into an inline meta line. App Store rows keep their own
  // layout below. See `.context/2026-05-29-feed-version-title-hierarchy.md`.
  const { descriptive, versionLabel } = deriveFeedTitle(release);

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

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setIsOverflowing(el.scrollHeight > COLLAPSED_MAX_HEIGHT);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
              {thumbnail && (
                <div className="shrink-0">
                  <FallbackImage
                    src={releaseThumbUrl(thumbnail.r2Url ?? thumbnail.url, 320)}
                    alt={thumbnail.alt || ""}
                    width={160}
                    height={90}
                    className="rounded-md object-cover w-[160px] h-[90px] border border-stone-200 dark:border-stone-800"
                    unoptimized={IMG_TRANSFORM_ON || undefined}
                  />
                </div>
              )}
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
            <div
              className={`group relative${isOverflowing ? " cursor-pointer" : ""}`}
              onClick={() => isOverflowing && setExpanded(!expanded)}
              {...(isOverflowing
                ? {
                    role: "button",
                    tabIndex: 0,
                    "aria-expanded": expanded,
                    "aria-label": expanded ? "Collapse release notes" : "Expand release notes",
                    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setExpanded(!expanded);
                      }
                    },
                  }
                : {})}
            >
              {expanded ? (
                <div className={markdownClasses}>
                  <ReactMarkdown
                    remarkPlugins={remarkPlugins}
                    rehypePlugins={[rehypeShikiPlugin]}
                    components={markdownComponents}
                  >
                    {markdownContent}
                  </ReactMarkdown>
                  <MediaGallery
                    media={release.media}
                    content={markdownContent}
                    onPreview={(src, alt) => setPreview({ src, alt })}
                  />
                </div>
              ) : (
                <>
                  <div className="flex gap-3">
                    <div
                      ref={contentRef}
                      className="relative max-h-[4.5em] overflow-hidden flex-1 min-w-0"
                    >
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
                      {isOverflowing && (
                        <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-stone-50 dark:from-stone-950 to-transparent" />
                      )}
                    </div>
                    {thumbnail && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPreview({
                            src: thumbnail.r2Url ?? thumbnail.url,
                            alt: thumbnail.alt || "",
                          });
                        }}
                        className="shrink-0 cursor-zoom-in"
                        aria-label="Preview image"
                      >
                        <FallbackImage
                          src={releaseThumbUrl(thumbnail.r2Url ?? thumbnail.url, 240)}
                          alt={thumbnail.alt || ""}
                          width={120}
                          height={72}
                          className="rounded-md object-cover w-[120px] h-[72px] border border-stone-200 dark:border-stone-800"
                          unoptimized={IMG_TRANSFORM_ON || undefined}
                        />
                      </button>
                    )}
                  </div>
                  {isOverflowing && (
                    <div className="text-xs text-stone-500 dark:text-stone-400 mt-1 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                      Show more
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
      {preview && <Lightbox src={preview.src} alt={preview.alt} onClose={() => setPreview(null)} />}
    </article>
  );
}
