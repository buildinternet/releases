"use client";

import { CommandTabs } from "@/components/command-tabs";
import { OpenInAgentMenu } from "@/components/open-in-agent-menu";
import { resolveTarget } from "@/lib/agent-launch";

const tabs = [
  {
    id: "npm",
    label: "npm",
    commands: ["npm install -g @buildinternet/releases"],
  },
  {
    id: "homebrew",
    label: "Homebrew",
    commands: ["brew install buildinternet/tap/releases"],
  },
  {
    id: "shell",
    label: "Shell",
    commands: ["curl -fsSL https://releases.sh/install | bash"],
  },
  {
    id: "mcp",
    label: "MCP",
    commands: ["https://mcp.releases.sh/mcp"],
  },
  {
    id: "skills",
    label: "Skills",
    commands: ["npx skills add buildinternet/releases-cli"],
  },
] as const;

export function InstallTabs() {
  return (
    <CommandTabs
      tabs={tabs}
      className="w-full"
      footer={(active) => (
        <div className="mt-2 flex justify-end">
          <OpenInAgentMenu target={resolveTarget(active.id)} className="shrink-0" />
        </div>
      )}
    />
  );
}
