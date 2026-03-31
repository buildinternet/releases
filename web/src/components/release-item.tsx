"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
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

const markdownComponents: Components = {
  img: ({ src, alt }) => {
    if (!src || typeof src !== "string") return null;
    return (
      <img
        src={src}
        alt={alt || ""}
        loading="lazy"
        className="rounded-md max-w-full h-auto my-2 max-h-80 object-contain"
      />
    );
  },
  a: ({ href, children }) => {
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

const collapsedMarkdownComponents: Components = {
  ...markdownComponents,
  img: () => null,
  a: ({ href, children }) => {
    // In collapsed view, render video links as plain text
    if (href && /youtube|vimeo|loom/i.test(href)) return <>{children}</>;
    return <a href={href}>{children}</a>;
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

const markdownClasses = "prose prose-sm prose-stone max-w-none text-[13px] leading-relaxed [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:mt-2 [&_h1]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:mt-1.5 [&_h3]:mb-0.5 [&_ul]:my-1 [&_ul]:pl-4 [&_li]:my-0 [&_p]:my-1 [&_a]:text-stone-600 [&_a]:no-underline [&_code]:text-xs [&_code]:bg-stone-100 [&_code]:px-1 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none";

export function ReleaseListItem({ release }: { release: ReleaseItem }) {
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
    <div className="border-b border-stone-200 py-4 first:pt-0 last:border-b-0 -mx-2 px-2 rounded">
      <button
        onClick={() => isOverflowing && setExpanded(!expanded)}
        className={`flex justify-between items-baseline mb-1 w-full text-left${isOverflowing ? "" : " cursor-default"}`}
      >
        <div className="flex items-baseline gap-1.5">
          {isOverflowing ? (
            <span className="text-stone-300 text-sm">{expanded ? "▾" : "▸"}</span>
          ) : (
            <span className="text-stone-300 text-sm">·</span>
          )}
          <span className="font-semibold text-[15px] text-stone-900">{heading}</span>
          {release.url && (
            <a href={release.url} target="_blank" rel="noopener noreferrer" className="text-stone-300 hover:text-stone-500 text-xs" onClick={(e) => e.stopPropagation()}>↗</a>
          )}
        </div>
        <span className="text-xs text-stone-400 whitespace-nowrap ml-4">{formatDate(release.publishedAt)}</span>
      </button>
      {showSubtitle && <div className="text-sm text-stone-600 mb-1 ml-2.5">{release.title}</div>}
      <div
        className={`ml-2.5 group relative${isOverflowing ? " cursor-pointer" : ""}`}
        onClick={() => isOverflowing && setExpanded(!expanded)}
      >
        {expanded ? (
          <div className={markdownClasses}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{markdownContent}</ReactMarkdown>
            <MediaGallery media={release.media} content={markdownContent} />
          </div>
        ) : (
          <>
            <div ref={contentRef} className="max-h-[4.5em] overflow-hidden">
              <div className={`${markdownClasses} text-stone-500 [&_strong]:text-stone-500`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={collapsedMarkdownComponents}>{markdownContent}</ReactMarkdown>
              </div>
            </div>
            {isOverflowing && (
              <>
                <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-stone-50 to-transparent" />
                <div className="text-xs text-stone-400 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  Show more
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
