import ReactMarkdown from "react-markdown";
import type { OverviewPageItem } from "@/lib/api";
import { remarkPlugins } from "@/lib/markdown-plugins";
import { markdownComponents } from "@/components/markdown-components";
import { stripLeadingHeading } from "@/lib/overview-citations";
import { BriefingClamp } from "./briefing-clamp";

/**
 * Compact "Recently shipped" briefing card for `/updates` (design option 8a).
 * Consumes the same `OverviewPageItem` payload as `OverviewView` — no forked
 * data fetching — but presents it compressed to a few lines instead of the
 * full clamp-at-1800px prose card, matching the mockup's dense header card.
 *
 * The markdown renders on the server through the same `react-markdown` stack
 * `OverviewView` uses, so inline code, links, and paragraph breaks survive; only
 * the collapse toggle is a client island. An earlier version ran the overview
 * through the OG `stripMarkdown` helper, which deletes the *contents* of inline
 * code spans — turning "(`none`/`minor`/`major`)" into "( / / )" — and collapses
 * every paragraph break into a single run of text.
 */
export function UpdatesBriefing({ page }: { page: OverviewPageItem }) {
  const content = stripLeadingHeading(page.content);
  const updatedDate = new Date(page.updatedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className="my-5 flex gap-3.5 rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
      >
        <path d="M12 3.5l1.5 4.2L18 9l-4.5 1.3L12 14.5l-1.5-4.2L6 9l4.5-1.3z" />
        <path d="M18.6 14.2l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6z" />
      </svg>
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex items-baseline gap-2.5">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.1em] text-stone-500 dark:text-stone-400">
            Recently shipped
          </h2>
          <span className="text-[11.5px] text-stone-400 dark:text-stone-500">
            {page.releaseCount} releases · updated {updatedDate}
          </span>
        </div>
        <BriefingClamp contentId="updates-briefing">
          <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
            {content}
          </ReactMarkdown>
        </BriefingClamp>
      </div>
    </div>
  );
}
