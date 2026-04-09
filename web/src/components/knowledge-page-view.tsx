import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { KnowledgePageItem } from "@/lib/api";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { markdownComponents } from "./markdown-components";

interface KnowledgePageViewProps {
  page: KnowledgePageItem;
}

const proseClasses = "prose prose-sm prose-stone dark:prose-invert max-w-none text-[13.5px] leading-relaxed [&_p]:my-2 [&_code]:text-[13px] [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none [&_a]:text-stone-600 dark:[&_a]:text-stone-400 [&_a]:no-underline text-stone-700 dark:text-stone-300";

export function KnowledgePageView({ page }: KnowledgePageViewProps) {
  const updatedDate = new Date(page.updatedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="mt-5">
      <div className="bg-stone-50 dark:bg-stone-900/50 border border-stone-200 dark:border-stone-800 rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] uppercase tracking-wide text-stone-400 dark:text-stone-500 font-medium">
            Overview
          </span>
          <span className="text-[11px] text-stone-300 dark:text-stone-600">
            {page.releaseCount} releases · updated {updatedDate}
          </span>
        </div>
        <div className={proseClasses}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeShikiPlugin]} components={markdownComponents}>
            {page.content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
