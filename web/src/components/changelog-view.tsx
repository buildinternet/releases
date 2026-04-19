import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { markdownComponents } from "./markdown-components";
import { api } from "@/lib/api";
import { formatRelativeDate } from "@/lib/formatters";
import { ChangelogStream } from "./changelog-stream";
import { ChangelogFilePicker } from "./changelog-file-picker";
import { DEFAULT_CHANGELOG_SLICE_LIMIT } from "@releases/core-internal/changelog-range";

const markdownClasses = "prose prose-sm prose-stone dark:prose-invert max-w-none text-[13px] leading-relaxed [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:mt-3 [&_h1]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-0.5 [&_ul]:my-1 [&_ul]:pl-4 [&_li]:my-0 [&_p]:my-1 [&_a]:text-stone-600 dark:[&_a]:text-stone-400 [&_a]:no-underline [&_code]:text-[13px] [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none";

export function ChangelogSkeleton() {
  return (
    <div className="mt-5 animate-pulse" aria-busy="true" aria-label="Loading changelog">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-3">
        <div className="h-3 w-32 rounded bg-stone-200 dark:bg-stone-800" />
        <div className="h-3 w-28 rounded bg-stone-200 dark:bg-stone-800" />
        <div className="h-3 w-20 rounded bg-stone-200 dark:bg-stone-800" />
      </div>
      <div className="space-y-2">
        <div className="h-3 w-1/3 rounded bg-stone-200 dark:bg-stone-800" />
        <div className="h-3 w-11/12 rounded bg-stone-200 dark:bg-stone-800" />
        <div className="h-3 w-10/12 rounded bg-stone-200 dark:bg-stone-800" />
        <div className="h-3 w-9/12 rounded bg-stone-200 dark:bg-stone-800" />
        <div className="h-3 w-1/4 rounded bg-stone-200 dark:bg-stone-800 mt-4" />
        <div className="h-3 w-11/12 rounded bg-stone-200 dark:bg-stone-800" />
        <div className="h-3 w-10/12 rounded bg-stone-200 dark:bg-stone-800" />
      </div>
    </div>
  );
}

export async function ChangelogView({
  sourceSlug,
  path,
  startOffset,
}: {
  sourceSlug: string;
  path?: string;
  /**
   * Byte offset into the file where the initial slice should start.
   * Used by search deep-links (`?tab=changelog&offset=N#chunk`) to jump
   * directly to a matched chunk. The range API snaps forward to the next
   * heading, so a mid-section offset still lands the user on a clean
   * section header. Defaults to 0 (full-file start).
   */
  startOffset?: number;
}) {
  const hasDeepLink = typeof startOffset === "number" && startOffset > 0;
  let file;
  try {
    file = await api.sourceChangelog(sourceSlug, {
      path,
      offset: startOffset,
      limit: DEFAULT_CHANGELOG_SLICE_LIMIT,
    });
  } catch {
    file = null;
  }

  if (!file) {
    return (
      <div className="mt-6 text-[13px] text-stone-500 dark:text-stone-400">
        No CHANGELOG file is available for this source.
      </div>
    );
  }

  // When the view was deep-linked from a search chunk hit, wrap the
  // initial slice in an anchor (`#chunk`) so the browser's hash-target
  // scrolling lands the user on it automatically. The range API already
  // snapped the offset forward to the nearest heading, so the first
  // element in `file.content` is the start of the matched section.
  const markdown = (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeShikiPlugin]}
      components={markdownComponents}
    >
      {file.content}
    </ReactMarkdown>
  );
  const initial = hasDeepLink ? (
    <div id="chunk" style={{ scrollMarginTop: "5rem" }}>
      {markdown}
    </div>
  ) : (
    markdown
  );

  const files = file.files ?? [];
  const hasMultiple = files.length > 1;

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-stone-500 dark:text-stone-400 mb-3">
        {hasMultiple ? (
          <ChangelogFilePicker files={files} activePath={file.path} />
        ) : (
          <span className="font-mono text-stone-600 dark:text-stone-300">{file.filename}</span>
        )}
        <span title={file.fetchedAt}>Last fetched {formatRelativeDate(file.fetchedAt)}</span>
        <a
          href={file.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200 underline"
        >
          View on GitHub
        </a>
      </div>
      {file.truncated && (
        <div
          role="alert"
          className="mb-4 rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-200"
        >
          This file exceeds 1MB and has been truncated{file.truncatedAt !== null ? ` at byte ${file.truncatedAt.toLocaleString()}` : ""}. The tail of the upstream file is not shown.
        </div>
      )}
      {hasDeepLink && (() => {
        // Build a path back to the top of the changelog so users who land
        // via a chunk deep-link can rewind to the preamble. Preserves the
        // active file path for multi-file sources.
        const topQs = new URLSearchParams({ tab: "changelog" });
        if (file.path) topQs.set("path", file.path);
        return (
          <div className="mb-3 flex items-center justify-between gap-2 rounded border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/60 px-3 py-2 text-[12px] text-stone-600 dark:text-stone-400">
            <span>Showing section starting at byte {file.offset.toLocaleString()} of {file.totalChars.toLocaleString()}.</span>
            <a
              href={`?${topQs.toString()}`}
              className="text-stone-600 dark:text-stone-300 underline hover:text-stone-900 dark:hover:text-stone-100"
            >
              Jump to top
            </a>
          </div>
        );
      })()}
      <ChangelogStream
        // Keying by path resets stream state on file switch so chunks from a
        // prior file don't bleed into the new one.
        key={file.path}
        slug={sourceSlug}
        activePath={file.path}
        markdownClassName={markdownClasses}
        initial={{
          content: initial,
          offset: file.offset,
          limit: DEFAULT_CHANGELOG_SLICE_LIMIT,
          nextOffset: file.nextOffset,
          totalChars: file.totalChars,
        }}
      />
    </div>
  );
}
