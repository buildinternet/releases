"use client";

import Image from "next/image";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { isSafeHref, isSafeImgSrc, isOptimizableImage } from "@/lib/sanitize";

interface MediaItem {
  type: "image" | "video" | "gif";
  url: string;
  alt?: string;
  r2Url?: string;
}

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
    if (!isSafeImgSrc(src)) return null;
    return (
      <img
        src={src}
        alt={props.alt || ""}
        loading="lazy"
        className="rounded-md max-w-full h-auto my-3"
      />
    );
  },
  a: (props: any) => {
    const href = props.href as string | undefined;
    const children = props.children;
    if (!isSafeHref(href)) return <>{children}</>;

    const ytMatch = href.match(
      /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?]+)/
    );
    if (ytMatch) {
      return (
        <div className="my-4 aspect-video max-w-2xl">
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

    const vimeoMatch = href.match(/vimeo\.com\/(\d+)/);
    if (vimeoMatch) {
      return (
        <div className="my-4 aspect-video max-w-2xl">
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

    const loomMatch = href.match(/loom\.com\/share\/([^?&]+)/);
    if (loomMatch) {
      return (
        <div className="my-4 aspect-video max-w-2xl">
          <iframe
            src={`https://www.loom.com/embed/${loomMatch[1]}`}
            className="w-full h-full rounded-md"
            allowFullScreen
            loading="lazy"
          />
        </div>
      );
    }

    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};

function MediaGallery({
  media,
  content,
}: {
  media: MediaItem[];
  content: string;
}) {
  if (!media || media.length === 0) return null;
  const extra = media.filter((m) => !content.includes(m.url));
  if (extra.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-3 mt-4">
      {extra.map((item, i) => {
        if (item.type === "image" || item.type === "gif") {
          const src = item.r2Url ?? item.url;
          return (
            <Image
              key={i}
              src={src}
              alt={item.alt || ""}
              width={600}
              height={320}
              className="rounded-md object-contain max-h-80 w-auto"
              unoptimized={!isOptimizableImage(src)}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

export function ReleaseContent({
  content,
  title,
  media,
}: {
  content: string;
  title: string;
  media: MediaItem[];
}) {
  const markdownContent = stripLeadingTitle(content, title);

  return (
    <div className="prose prose-stone dark:prose-invert max-w-none text-[15px] leading-relaxed [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2 [&_h3]:text-[15px] [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_ul]:my-2 [&_ul]:pl-5 [&_li]:my-0.5 [&_p]:my-2 [&_a]:text-stone-600 dark:[&_a]:text-stone-400 [&_a]:no-underline [&_code]:text-sm [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
        {markdownContent}
      </ReactMarkdown>
      <MediaGallery media={media} content={markdownContent} />
    </div>
  );
}
