"use client";

import { useState } from "react";
import { CopyIcon } from "@/components/copy-icon";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

type TabId = (typeof tabs)[number]["id"];

const tabs = [
  {
    id: "npm",
    label: "npm",
    command: "npm install -g @buildinternet/releases",
  },
  {
    id: "shell",
    label: "Shell",
    command: "curl -fsSL https://releases.sh/install | bash",
  },
  {
    id: "mcp",
    label: "MCP",
    command: "https://mcp.releases.sh/mcp",
  },
] as const;

export function InstallTabs() {
  const [active, setActive] = useState<TabId>("npm");
  const { copied, copy } = useCopyToClipboard();

  const current = tabs.find((t) => t.id === active)!;

  return (
    <div className="w-full max-w-[540px] mx-auto">
      <div className="flex border-b border-stone-200 dark:border-stone-700">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActive(tab.id)}
            className={`px-4 py-2 text-[13px] font-medium transition-colors ${
              active === tab.id
                ? "text-stone-900 dark:text-stone-100 border-b-2 border-stone-900 dark:border-stone-100 -mb-px"
                : "text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        onClick={() => copy(current.command)}
        className="bg-stone-100 dark:bg-stone-900 border border-t-0 border-stone-200 dark:border-stone-700 rounded-b-lg px-4 py-3 flex items-center justify-between gap-3 cursor-pointer hover:bg-stone-200 dark:hover:bg-stone-800/80 transition-colors"
      >
        <code className="text-[13px] font-mono text-stone-700 dark:text-stone-300 overflow-x-auto whitespace-nowrap pointer-events-none">
          {current.command}
        </code>
        <span className="shrink-0 p-1.5 text-stone-400 dark:text-stone-500">
          <CopyIcon copied={copied} />
        </span>
      </div>
    </div>
  );
}
