import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReleaseSummaryItem } from "@/lib/api";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { markdownComponents } from "./markdown-components";

interface HighlightsViewProps {
  rolling: ReleaseSummaryItem | null;
  monthly: ReleaseSummaryItem[];
}

const summaryClasses =
  "prose prose-sm prose-stone dark:prose-invert max-w-none text-[13px] leading-relaxed [&_p]:my-1 [&_code]:text-[13px] [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none [&_ul]:my-1 [&_ul]:pl-4 [&_li]:my-0 [&_a]:text-stone-600 dark:[&_a]:text-stone-400 [&_a]:no-underline text-stone-700 dark:text-stone-300";

function formatMonth(year: number, month: number): string {
  const date = new Date(Date.UTC(year, month - 1));
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

export function HighlightsView({ rolling, monthly }: HighlightsViewProps) {
  if (!rolling && monthly.length === 0) {
    return (
      <div className="py-12 text-center text-stone-400 dark:text-stone-500 text-sm">
        No summaries generated yet. Summaries are created automatically when new releases are
        fetched.
      </div>
    );
  }

  const sortedMonthly = [...monthly]
    .toSorted((a, b) => {
      if (a.year !== b.year) return (b.year ?? 0) - (a.year ?? 0);
      return (b.month ?? 0) - (a.month ?? 0);
    })
    .filter(
      (m, i, arr) => i === 0 || `${m.year}-${m.month}` !== `${arr[i - 1].year}-${arr[i - 1].month}`,
    );

  return (
    <div className="pt-4">
      {/* Rolling summary — card format */}
      {rolling && (
        <div className="bg-stone-50 dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg p-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] uppercase tracking-wide text-stone-400 dark:text-stone-500 font-medium">
              Recent Highlights
            </span>
            <span className="text-[11px] text-stone-300 dark:text-stone-600">
              {rolling.releaseCount} releases · last {rolling.windowDays ?? 90} days
            </span>
          </div>
          <div className={summaryClasses}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeShikiPlugin]}
              components={markdownComponents}
            >
              {rolling.summary}
            </ReactMarkdown>
          </div>
          {rolling.generatedAt && (
            <div className="text-[10px] text-stone-400 dark:text-stone-600 mt-3 tabular-nums">
              Generated{" "}
              {new Date(rolling.generatedAt).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "numeric",
                minute: "2-digit",
                timeZoneName: "short",
              })}
            </div>
          )}
        </div>
      )}

      {/* Monthly summaries */}
      {sortedMonthly.map((m) => (
        <div key={`${m.year}-${m.month}`} className="flex gap-0 relative">
          <div className="w-[100px] shrink-0 relative flex flex-col items-end pr-5 pt-4">
            <span className="text-[12px] text-stone-400 dark:text-stone-500 whitespace-nowrap tabular-nums">
              {m.year && m.month ? formatMonth(m.year, m.month) : ""}
            </span>
            <div className="absolute right-0 top-[20px] w-[7px] h-[7px] rounded-full bg-stone-300 dark:bg-stone-600 translate-x-[3px] z-10" />
          </div>
          <div className="absolute left-[100px] top-0 bottom-0 w-px bg-stone-200 dark:bg-stone-800" />
          <div className="flex-1 min-w-0 border-t border-stone-200 dark:border-stone-800 py-4 pl-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] uppercase tracking-wide text-stone-400 dark:text-stone-500 font-medium">
                {m.year && m.month ? formatMonth(m.year, m.month) : "Monthly Summary"}
              </span>
              <span className="text-[11px] text-stone-300 dark:text-stone-600">
                {m.releaseCount} releases
              </span>
            </div>
            <div className={summaryClasses}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeShikiPlugin]}
                components={markdownComponents}
              >
                {m.summary}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
