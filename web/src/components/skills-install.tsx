"use client";

import { useState } from "react";
import { CommandSyntax } from "@/components/command-syntax";
import { CopyIcon } from "@/components/copy-icon";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

type TabId = "standalone" | "plugin";

const tabs: ReadonlyArray<{
  id: TabId;
  label: string;
  commands: ReadonlyArray<string>;
  note: string;
}> = [
  {
    id: "standalone",
    label: "Standalone (any agent)",
    commands: ["npx skills add buildinternet/releases-cli"],
    note: "Drops skill files into the project. Works in Claude Code, Codex, Cursor, OpenCode.",
  },
  {
    id: "plugin",
    label: "Claude Code plugin",
    commands: [
      "/plugin marketplace add buildinternet/releases-cli",
      "/plugin install releases@releases",
    ],
    note: "Adds the skills plus the bundled MCP server and /releases command.",
  },
];

export function SkillsInstall() {
  const [active, setActive] = useState<TabId>("standalone");
  const { copied, copy } = useCopyToClipboard();
  const current = tabs.find((t) => t.id === active)!;
  const copyText = current.commands.join("\n");

  return (
    <div className="not-prose my-6 w-full max-w-[640px]">
      <div className="flex border-b border-stone-200 dark:border-stone-700">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActive(tab.id)}
            className={`shrink-0 px-4 py-2 text-[13px] font-medium transition-colors ${
              active === tab.id
                ? "-mb-px border-b-2 border-stone-900 text-stone-900 dark:border-stone-100 dark:text-stone-100"
                : "text-stone-400 hover:text-stone-600 dark:text-stone-500 dark:hover:text-stone-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        onClick={() => copy(copyText)}
        className="flex cursor-pointer items-start justify-between gap-3 rounded-b-lg border border-t-0 border-stone-200 bg-stone-100 px-4 py-3 transition-colors hover:bg-stone-200 dark:border-stone-700 dark:bg-stone-900 dark:hover:bg-stone-800/80"
      >
        <div className="pointer-events-none flex flex-col gap-1 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {current.commands.map((cmd) => (
            <code
              key={cmd}
              className="whitespace-nowrap font-mono text-[13px] text-stone-700 dark:text-stone-300"
            >
              <CommandSyntax command={cmd} />
            </code>
          ))}
        </div>
        <span className="shrink-0 p-1.5 text-stone-400 dark:text-stone-500">
          <CopyIcon copied={copied} />
        </span>
      </div>
      <p className="mt-2 text-[12px] text-stone-500 dark:text-stone-500">{current.note}</p>
    </div>
  );
}
