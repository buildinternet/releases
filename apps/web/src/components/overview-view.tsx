import ReactMarkdown from "react-markdown";
import { remarkPlugins } from "@/lib/markdown-plugins";
import type { OverviewPageItem } from "@/lib/api";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { stripLeadingHeading } from "@/lib/overview-citations";
import { AI_SUMMARY_DISCLAIMER } from "@/lib/copy";
import { markdownComponents } from "./markdown-components";
import { OverviewSourceChips } from "./overview-source-chips";
import { OverviewClamp } from "./overview-clamp";
import { orgEyebrowClass } from "@releases/design-system";

interface OverviewViewProps {
  page: OverviewPageItem;
  /**
   * `"org"` renders the card with the org-page redesign tokens (accent eyebrow,
   * `--surface-2` card) — only safe inside `.org-surface`, where the tokens are
   * defined. `"default"` (product pages, timeline fallback) keeps the stone
   * styling. The markdown/citation pipeline is identical across both.
   */
  variant?: "default" | "org";
}

const CHROME = {
  default: {
    outer: "mt-5",
    card: "rounded-lg border border-stone-200 bg-stone-50 p-5 dark:border-stone-800 dark:bg-stone-900/50",
    eyebrow: "text-[11px] font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500",
    meta: "text-[11px] text-stone-300 dark:text-stone-600",
    fade: "from-stone-50 dark:from-stone-900/50",
    disclaimer: "border-stone-200 text-stone-400 dark:border-stone-800 dark:text-stone-500",
  },
  org: {
    outer: "mb-6",
    card: "rounded-[14px] border border-[var(--line)] bg-[var(--surface-2)] p-[22px]",
    eyebrow: orgEyebrowClass,
    meta: "font-mono text-[11.5px] text-[var(--fg-3)]",
    fade: "from-[var(--surface-2)]",
    disclaimer: "border-[var(--line)] text-[var(--fg-3)]",
  },
} as const;

const proseClasses =
  "prose prose-sm prose-stone dark:prose-invert max-w-none break-words text-[13.5px] leading-relaxed [&_p]:my-2 [&_code]:text-[13px] [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none [&_a]:text-stone-600 dark:[&_a]:text-stone-400 [&_a]:no-underline text-stone-700 dark:text-stone-300 [&_sup_a]:text-stone-500 dark:[&_sup_a]:text-stone-400 [&_sup_a]:no-underline [&_sup_a]:font-medium [&_sup_a:hover]:text-stone-800 dark:[&_sup_a:hover]:text-stone-200";

/**
 * Server component: the AI-overview card. The citation injection and the
 * `react-markdown` + shiki render both run on the server (the same pipeline
 * `ReleaseContent` uses), so none of that JS reaches the browser. The two
 * genuinely-interactive bits are isolated client islands: {@link OverviewClamp}
 * (the rarely-tripped "Show more" clamp + disclaimer) wraps the server-rendered
 * body as `children`, and {@link OverviewSourceChips} (the collapsible Sources
 * footer) is rendered in place of the GFM footnotes section.
 */
export function OverviewView({ page, variant = "default" }: OverviewViewProps) {
  const chrome = CHROME[variant];

  // Deterministic per-entity id: unique across the (at most one) org and one
  // product overview that can share a page, and stable between server render
  // and hydration (unlike `useId`, which isn't available in a server
  // component). Used as the content div id for the clamp's `aria-controls`.
  const contentId =
    "overview-" + [page.scope, page.orgSlug, page.productSlug].filter(Boolean).join("-");

  // Citations render as a Sources chip footer below the body, not as inline
  // superscripts (#1934) — so the body is just the stored markdown with a stray
  // leading heading stripped (the org page already shows the org name).
  const renderedContent = stripLeadingHeading(page.content);

  const updatedDate = new Date(page.updatedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className={chrome.outer}>
      <div className={chrome.card}>
        <div className="flex items-center justify-between mb-3">
          <span className={chrome.eyebrow}>Recently Shipped</span>
          <span className={chrome.meta}>
            {page.releaseCount} releases · updated {updatedDate}
          </span>
        </div>
        <OverviewClamp
          contentId={contentId}
          proseClasses={proseClasses}
          fadeClass={chrome.fade}
          disclaimerClass={chrome.disclaimer}
          disclaimer={AI_SUMMARY_DISCLAIMER}
        >
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={[rehypeShikiPlugin]}
            components={markdownComponents}
          >
            {renderedContent}
          </ReactMarkdown>
        </OverviewClamp>
        <OverviewSourceChips citations={page.citations} />
      </div>
    </div>
  );
}
