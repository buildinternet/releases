import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { markdownComponents } from "./markdown-components";
import { api } from "@/lib/api";
import { formatRelativeDate } from "@/lib/formatters";

const markdownClasses = "prose prose-sm prose-stone dark:prose-invert max-w-none text-[13px] leading-relaxed [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:mt-3 [&_h1]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-0.5 [&_ul]:my-1 [&_ul]:pl-4 [&_li]:my-0 [&_p]:my-1 [&_a]:text-stone-600 dark:[&_a]:text-stone-400 [&_a]:no-underline [&_code]:text-[13px] [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none";

export async function ChangelogView({ sourceSlug }: { sourceSlug: string }) {
  let file;
  try {
    file = await api.sourceChangelog(sourceSlug);
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

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-stone-500 dark:text-stone-400 mb-3">
        <span className="font-mono text-stone-600 dark:text-stone-300">{file.filename}</span>
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
      <div className={markdownClasses}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeShikiPlugin]} components={markdownComponents}>
          {file.content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
