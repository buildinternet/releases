"use client";

import { CopyIcon } from "@/components/copy-icon";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

export function CopyPageButton({
  markdown,
  slug,
}: {
  markdown: string;
  slug: string;
}) {
  const { copied, copy } = useCopyToClipboard();
  const viewHref = `/docs/${slug === "index" ? "" : slug}.md`;

  return (
    <div className="inline-flex items-center gap-1 rounded-md border border-stone-200 bg-white text-[12px] font-medium text-stone-700 shadow-sm dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300">
      <button
        type="button"
        onClick={() => copy(markdown)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-800 rounded-l-md transition-colors"
      >
        <CopyIcon copied={copied} size={14} />
        {copied ? "Copied" : "Copy page"}
      </button>
      <span className="h-4 w-px bg-stone-200 dark:bg-stone-700" />
      <a
        href={viewHref}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-800 rounded-r-md transition-colors"
        title="View as markdown"
      >
        View .md
      </a>
    </div>
  );
}
