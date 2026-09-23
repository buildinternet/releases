"use client";

import { useRef, useState, type ReactNode } from "react";
import { CommandSyntax } from "@/components/command-syntax";
import { CopyButton } from "@/components/ui/copy-button";

export type CommandTab = {
  id: string;
  label: string;
  /** One or more lines copied together as a single clipboard write. */
  commands: readonly string[];
};

/**
 * Shared tab strip + copyable command block: {@link InstallTabs} and
 * {@link SkillsInstall} are thin wrappers around this with their own tab
 * data, sizing, and a `footer` slot for whatever renders below the block
 * (an agent-launch menu, a help note, or nothing).
 */
export function CommandTabs<T extends CommandTab>({
  tabs,
  className,
  footer,
}: {
  tabs: readonly T[];
  className?: string;
  footer?: (active: T) => ReactNode;
}) {
  const [activeId, setActiveId] = useState<T["id"]>(tabs[0].id);
  const copyRef = useRef<HTMLButtonElement>(null);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const copyText = active.commands.join("\n");
  const isMultiline = active.commands.length > 1;

  return (
    <div className={className}>
      <div className="flex overflow-x-auto border-b border-stone-200 dark:border-stone-700 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveId(tab.id)}
            className={`shrink-0 whitespace-nowrap px-4 py-2 text-[13px] font-medium transition-colors ${
              activeId === tab.id
                ? "text-stone-900 dark:text-stone-100 border-b-2 border-stone-900 dark:border-stone-100 -mb-px"
                : "text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        onClick={() => copyRef.current?.click()}
        className={`flex w-full cursor-pointer justify-between gap-3 rounded-b-lg border border-t-0 border-stone-200 bg-stone-100 px-4 py-3 transition-colors hover:bg-stone-200 dark:border-stone-700 dark:bg-stone-900 dark:hover:bg-stone-800/80 ${
          isMultiline ? "items-start" : "items-center"
        }`}
      >
        <div className="pointer-events-none flex min-w-0 flex-1 flex-col gap-1">
          {active.commands.map((cmd) => (
            <code
              key={cmd}
              className="whitespace-pre-wrap break-words font-mono text-[13px] text-stone-700 dark:text-stone-300"
            >
              <CommandSyntax command={cmd} />
            </code>
          ))}
        </div>
        <CopyButton
          ref={copyRef}
          text={copyText}
          aria-label={`Copy command: ${copyText}`}
          className={isMultiline ? "-mt-1" : undefined}
        />
      </div>

      {footer?.(active)}
    </div>
  );
}
