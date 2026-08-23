"use client";

import { useRef, useState } from "react";
import { CommandSyntax } from "@/components/command-syntax";
import { OpenInAgentMenu } from "@/components/open-in-agent-menu";
import { CopyButton } from "@/components/ui/copy-button";
import { resolveTarget } from "@/lib/agent-launch";

type TabId = (typeof tabs)[number]["id"];

const tabs = [
  {
    id: "npm",
    label: "npm",
    command: "npm install -g @buildinternet/releases",
  },
  {
    id: "homebrew",
    label: "Homebrew",
    command: "brew install buildinternet/tap/releases",
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
  {
    id: "skills",
    label: "Skills",
    command: "npx skills add buildinternet/releases-cli",
  },
] as const;

export function InstallTabs() {
  const [active, setActive] = useState<TabId>("npm");
  const copyRef = useRef<HTMLButtonElement>(null);

  const current = tabs.find((t) => t.id === active)!;

  return (
    <div className="w-full">
      <div className="flex overflow-x-auto border-b border-stone-200 dark:border-stone-700 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActive(tab.id)}
            className={`shrink-0 whitespace-nowrap px-4 py-2 text-[13px] font-medium transition-colors ${
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
        onClick={() => copyRef.current?.click()}
        className="w-full flex items-center justify-between gap-3 bg-stone-100 dark:bg-stone-900 border border-t-0 border-stone-200 dark:border-stone-700 rounded-b-lg px-4 py-3 cursor-pointer hover:bg-stone-200 dark:hover:bg-stone-800/80 transition-colors"
      >
        <code className="min-w-0 flex-1 text-[13px] font-mono text-stone-700 dark:text-stone-300 whitespace-pre-wrap break-words pointer-events-none">
          <CommandSyntax command={current.command} />
        </code>
        <CopyButton
          ref={copyRef}
          text={current.command}
          aria-label={`Copy command: ${current.command}`}
        />
      </div>

      <div className="mt-2 flex justify-end">
        <OpenInAgentMenu target={resolveTarget(active)} className="shrink-0" />
      </div>
    </div>
  );
}
