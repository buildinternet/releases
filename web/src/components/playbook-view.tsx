import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { markdownComponents } from "./markdown-components";

interface PlaybookViewProps {
  playbook: { content: string; updatedAt: string };
}

const proseClasses = "prose prose-sm prose-stone dark:prose-invert max-w-none text-[13.5px] leading-relaxed [&_p]:my-2 [&_code]:text-[13px] [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none [&_a]:text-stone-600 dark:[&_a]:text-stone-400 [&_a]:no-underline text-stone-700 dark:text-stone-300 overflow-x-auto [&_table]:w-full [&_table]:text-[12.5px] [&_td]:break-all [&_td]:max-w-[200px]";

export function PlaybookView({ playbook }: PlaybookViewProps) {
  const updatedDate = new Date(playbook.updatedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className="mt-5">
      <div className="bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200/60 dark:border-amber-900/40 rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] uppercase tracking-wide text-amber-600/70 dark:text-amber-500/60 font-medium">
            Playbook
          </span>
          <span className="text-[11px] text-amber-400/60 dark:text-amber-600/50">
            updated {updatedDate}
          </span>
        </div>
        <div className={proseClasses}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeShikiPlugin]} components={markdownComponents}>
            {playbook.content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
