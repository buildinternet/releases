"use client";

import { useRef } from "react";
import { CommandSyntax } from "@/components/command-syntax";
import { CopyButton } from "@/components/ui/copy-button";

type CliCommandProps =
  | { identifier: string; command?: never; className?: string }
  | { command: string; identifier?: never; className?: string };

export function CliCommand({ identifier, command, className }: CliCommandProps) {
  const copyRef = useRef<HTMLButtonElement>(null);
  const resolved = command ?? `npx @buildinternet/releases get ${identifier}`;

  return (
    <div
      onClick={() => copyRef.current?.click()}
      className={`inline-flex max-w-full cursor-pointer items-center gap-2 rounded-md border border-stone-200 bg-stone-50 px-3 py-1.5 text-left font-mono text-[12px] text-stone-700 shadow-sm transition-colors hover:border-stone-300 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300 dark:hover:border-stone-600 ${className ?? "mt-4"}`}
    >
      <span className="select-none text-stone-400 dark:text-stone-500">$</span>
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-words pointer-events-none">
        <CommandSyntax command={resolved} />
      </code>
      <CopyButton ref={copyRef} text={resolved} aria-label={`Copy command: ${resolved}`} />
    </div>
  );
}
