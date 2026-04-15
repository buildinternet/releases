"use client";

import { CopyIcon } from "@/components/copy-icon";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

export function InlineCopyCode({ code }: { code: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <button
      type="button"
      onClick={() => copy(code)}
      className="inline-flex items-center gap-1.5 rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[11px] text-stone-600 transition-colors hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-stone-700"
      aria-label={copied ? "Copied" : "Copy command"}
      title={copied ? "Copied" : "Copy command"}
    >
      <span>{code}</span>
      <CopyIcon copied={copied} size={11} />
    </button>
  );
}
