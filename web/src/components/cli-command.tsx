"use client";

import { CopyIcon } from "@/components/copy-icon";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

type CliCommandProps =
  | { identifier: string; command?: never; className?: string }
  | { command: string; identifier?: never; className?: string };

export function CliCommand({ identifier, command, className }: CliCommandProps) {
  const { copied, copy } = useCopyToClipboard();
  const resolved = command ?? `npx @buildinternet/releases get ${identifier}`;

  return (
    <div
      className={`inline-flex max-w-full items-center gap-2 rounded-md border border-stone-200 bg-stone-50 px-3 py-1.5 font-mono text-[12px] text-stone-700 shadow-sm dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300 ${className ?? "mt-4"}`}
    >
      <span className="select-none text-stone-400 dark:text-stone-500">$</span>
      <span className="truncate">{resolved}</span>
      <button
        type="button"
        onClick={() => copy(resolved)}
        className="flex-shrink-0 rounded p-0.5 text-stone-500 transition-colors hover:bg-stone-200 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-200"
        aria-label={copied ? "Copied" : "Copy command"}
        title={copied ? "Copied" : "Copy command"}
      >
        <CopyIcon copied={copied} size={13} />
      </button>
    </div>
  );
}
