"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import type { ReleaseItem } from "@/lib/api";

function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function ReleaseListItem({ release }: { release: ReleaseItem }) {
  const [expanded, setExpanded] = useState(false);
  const hasVersion = !!release.version;
  const titleMatchesVersion = release.title === release.version
    || release.title === release.version?.replace(/^v/, "")
    || release.version === release.title?.replace(/^v/, "");

  const markdownContent = release.content || release.summary;

  // Primary heading: version if available, otherwise title
  const heading = hasVersion ? release.version : release.title;

  // Show subtitle title only when we have a version AND title is different from it
  const showSubtitle = hasVersion && release.title && !titleMatchesVersion;

  return (
    <div className="border-b border-stone-200 py-4 first:pt-0 last:border-b-0 -mx-2 px-2 rounded">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex justify-between items-baseline mb-1 w-full text-left"
      >
        <div className="flex items-baseline gap-1.5">
          <span className="text-stone-300 text-sm">{expanded ? "▾" : "▸"}</span>
          <span className="font-semibold text-[15px] text-stone-900">{heading}</span>
          {release.url && (
            <a href={release.url} target="_blank" rel="noopener noreferrer" className="text-stone-300 hover:text-stone-500 text-xs" onClick={(e) => e.stopPropagation()}>↗</a>
          )}
        </div>
        <span className="text-xs text-stone-400 whitespace-nowrap ml-4">{formatDate(release.publishedAt)}</span>
      </button>
      {showSubtitle && <div className="text-sm text-stone-600 mb-1 pl-5">{release.title}</div>}
      {expanded ? (
        <div className="pl-5">
          <div className="prose prose-sm prose-stone max-w-none text-[13px] leading-relaxed [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:mt-2 [&_h1]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:mt-1.5 [&_h3]:mb-0.5 [&_ul]:my-1 [&_ul]:pl-4 [&_li]:my-0 [&_p]:my-1 [&_a]:text-stone-600 [&_a]:no-underline [&_code]:text-xs [&_code]:bg-stone-100 [&_code]:px-1 [&_code]:rounded">
            <ReactMarkdown>{markdownContent}</ReactMarkdown>
          </div>
        </div>
      ) : (
        <div className="relative max-h-[60px] overflow-hidden pl-5">
          <div className="text-sm text-stone-500 line-clamp-2">
            {release.summary || (markdownContent ? markdownContent.slice(0, 150) : "No release notes provided")}
          </div>
        </div>
      )}
    </div>
  );
}
