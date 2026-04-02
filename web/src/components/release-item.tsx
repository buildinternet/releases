"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import Link from "next/link";
import type { ReleaseItem } from "@/lib/api";

function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Strip a leading markdown heading that duplicates the release title */
function stripLeadingTitle(content: string, title: string | null): string {
  if (!title || !content) return content;
  const firstNewline = content.indexOf("\n");
  if (firstNewline === -1) return content;
  const firstLine = content.slice(0, firstNewline).replace(/^#+\s+/, "").trim();
  if (firstLine.toLowerCase() === title.toLowerCase()) {
    return content.slice(firstNewline + 1).trimStart();
  }
  return content;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const markdownComponents: Record<string, any> = {
  img: (props: any) => {
    const src = props.src as string | undefined;
    if (!src || typeof src !== "string") return null;
    return (
      <img
        src={src}
        alt={props.alt || ""}
        loading="lazy"
        className="rounded-md max-w-full h-auto my-2 max-h-80 object-contain"
      />
    );
  },
  a: (props: any) => {
    const href = props.href as string | undefined;
    const children = props.children;
    if (!href) return <>{children}</>;

    // YouTube embed
    const ytMatch = href.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?]+)/);
    if (ytMatch) {
      return (
        <div className="my-3 aspect-video max-w-lg">
          <iframe
            src={`https://www.youtube.com/embed/${ytMatch[1]}`}
            className="w-full h-full rounded-md"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            loading="lazy"
          />
        </div>
      );
    }

    // Vimeo embed
    const vimeoMatch = href.match(/vimeo\.com\/(\d+)/);
    if (vimeoMatch) {
      return (
        <div className="my-3 aspect-video max-w-lg">
          <iframe
            src={`https://player.vimeo.com/video/${vimeoMatch[1]}`}
            className="w-full h-full rounded-md"
            allow="autoplay; fullscreen; picture-in-picture"
            allowFullScreen
            loading="lazy"
          />
        </div>
      );
    }

    // Loom embed
    const loomMatch = href.match(/loom\.com\/share\/([^?&]+)/);
    if (loomMatch) {
      return (
        <div className="my-3 aspect-video max-w-lg">
          <iframe
            src={`https://www.loom.com/embed/${loomMatch[1]}`}
            className="w-full h-full rounded-md"
            allowFullScreen
            loading="lazy"
          />
        </div>
      );
    }

    // Regular link
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};

const collapsedMarkdownComponents: Record<string, any> = {
  ...markdownComponents,
  img: () => null,
  a: (props: any) => {
    const href = props.href as string | undefined;
    const children = props.children;
    if (href && /youtube|vimeo|loom/i.test(href)) return <>{children}</>;
    return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  },
};

function MediaGallery({ media, content }: { media: ReleaseItem["media"]; content: string }) {
  if (!media || media.length === 0) return null;

  // Filter out items already rendered inline via markdown content
  const extra = media.filter(m => !content.includes(m.url));
  if (extra.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {extra.map((item, i) => {
        if (item.type === "image" || item.type === "gif") {
          const src = item.r2Url ?? item.url;
          return (
            <img
              key={i}
              src={src}
              alt={item.alt || ""}
              loading="lazy"
              className="rounded-md max-h-48 object-contain"
            />
          );
        }
        return null;
      })}
    </div>
  );
}

const COLLAPSED_MAX_HEIGHT = 72; // ~4.5em at 16px

const markdownClasses = "prose prose-sm prose-stone dark:prose-invert max-w-none text-[13px] leading-relaxed [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:mt-2 [&_h1]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:mt-1.5 [&_h3]:mb-0.5 [&_ul]:my-1 [&_ul]:pl-4 [&_li]:my-0 [&_p]:my-1 [&_a]:text-stone-600 dark:[&_a]:text-stone-400 [&_a]:no-underline [&_code]:text-[13px] [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none";

export function ReleaseListItem({ release, hideDate, sourceByline }: { release: ReleaseItem; hideDate?: boolean; sourceByline?: { name: string; slug: string; orgSlug?: string } }) {
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const hasVersion = !!release.version;
  const titleMatchesVersion = release.title === release.version
    || release.title === release.version?.replace(/^v/, "")
    || release.version === release.title?.replace(/^v/, "");

  const markdownContent = useMemo(
    () => stripLeadingTitle(release.content || release.summary, release.title),
    [release.content, release.summary, release.title]
  );

  // Primary heading: version if available, otherwise title
  const heading = hasVersion ? release.version : release.title;

  // Show subtitle title only when we have a version AND title is different from it
  const showSubtitle = hasVersion && release.title && !titleMatchesVersion;

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setIsOverflowing(el.scrollHeight > COLLAPSED_MAX_HEIGHT);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="group/item flex gap-0 relative">
      {/* Left rail: date + timeline */}
      <div className="w-[100px] shrink-0 relative flex flex-col items-end pr-5 pt-5">
        {!hideDate && <span className="text-[12px] text-stone-400 dark:text-stone-500 whitespace-nowrap tabular-nums">{formatDate(release.publishedAt)}</span>}
        {/* Dot on timeline */}
        <div className="absolute right-0 top-[22px] w-[7px] h-[7px] rounded-full bg-stone-300 dark:bg-stone-600 translate-x-[3px] z-10" />
      </div>
      {/* Timeline line */}
      <div className="absolute left-[100px] top-0 bottom-0 w-px bg-stone-200 dark:bg-stone-800" />
      {/* Content */}
      <div className="flex-1 min-w-0 border-b border-stone-200 dark:border-stone-800 last:border-b-0 py-4 pl-5">
        <button
          onClick={() => isOverflowing && setExpanded(!expanded)}
          className={`flex items-baseline gap-1.5 mb-1 w-full text-left${isOverflowing ? "" : " cursor-default"}`}
        >
          <span className="font-semibold text-[15px] text-stone-900 dark:text-stone-100">{heading}</span>
          {release.url && (
            <a href={release.url} target="_blank" rel="noopener noreferrer" className="text-stone-300 dark:text-stone-600 hover:text-stone-500 dark:hover:text-stone-400 text-xs" onClick={(e) => e.stopPropagation()}>↗</a>
          )}
          {release.id && (
            <Link
              href={`/release/${release.id}`}
              className="text-stone-300 dark:text-stone-600 hover:text-stone-500 dark:hover:text-stone-400 text-xs opacity-0 group-hover/item:opacity-100 transition-opacity"
              onClick={(e) => e.stopPropagation()}
              title="Permalink"
            >
              #
            </Link>
          )}
        </button>
        {showSubtitle && <div className="text-sm text-stone-600 dark:text-stone-400 mb-1">{release.title}</div>}
        {sourceByline && (
          <div className="text-[12px] text-stone-400 dark:text-stone-500 mb-1">
            via{" "}
            {sourceByline.orgSlug ? (
              <Link href={`/${sourceByline.orgSlug}/${sourceByline.slug}`} className="text-stone-500 dark:text-stone-400 font-medium hover:text-stone-700 dark:hover:text-stone-300" onClick={(e) => e.stopPropagation()}>
                {sourceByline.name}
              </Link>
            ) : (
              <span className="text-stone-500 dark:text-stone-400 font-medium">{sourceByline.name}</span>
            )}
          </div>
        )}
        <div
          className={`group relative${isOverflowing ? " cursor-pointer" : ""}`}
          onClick={() => isOverflowing && setExpanded(!expanded)}
        >
          {expanded ? (
            <div className={markdownClasses}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>{markdownContent}</ReactMarkdown>
              <MediaGallery media={release.media} content={markdownContent} />
            </div>
          ) : (
            <>
              <div ref={contentRef} className="max-h-[4.5em] overflow-hidden">
                <div className={`${markdownClasses} text-stone-500 dark:text-stone-400 [&_strong]:text-stone-500 dark:[&_strong]:text-stone-400`}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={collapsedMarkdownComponents}>{markdownContent}</ReactMarkdown>
                </div>
              </div>
              {isOverflowing && (
                <>
                  <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-stone-50 dark:from-stone-950 to-transparent" />
                  <div className="text-xs text-stone-400 dark:text-stone-500 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    Show more
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
