"use client";

import { CommandSyntax } from "@/components/command-syntax";
import { CopyIcon } from "@/components/copy-icon";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

type CliCommandProps =
  | { identifier: string; command?: never; className?: string }
  | { command: string; identifier?: never; className?: string };

export function CliCommand({ identifier, command, className }: CliCommandProps) {
  const { copied, copy } = useCopyToClipboard();
  const resolved = command ?? `npx @buildinternet/releases get ${identifier}`;

  return (
    <button
      type="button"
      onClick={() => copy(resolved)}
      aria-label={copied ? "Copied" : `Copy command: ${resolved}`}
      title={copied ? "Copied" : "Copy command"}
      className={`group inline-flex max-w-full cursor-pointer items-center gap-2 rounded-md border border-stone-200 bg-stone-50 px-3 py-1.5 text-left font-mono text-[12px] text-stone-700 shadow-sm transition-colors hover:border-stone-300 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300 dark:hover:border-stone-600 ${className ?? "mt-4"}`}
    >
      <span className="select-none text-stone-400 dark:text-stone-500">$</span>
      <code className="min-w-0 truncate">
        <CommandSyntax command={resolved} />
      </code>
      <span className="flex-shrink-0 text-stone-500 transition-colors group-hover:text-stone-700 dark:text-stone-400 dark:group-hover:text-stone-200">
        <CopyIcon copied={copied} size={13} />
      </span>
    </button>
  );
}
