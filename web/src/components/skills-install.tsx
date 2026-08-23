"use client";

import { CommandTabs } from "@/components/command-tabs";

const tabs = [
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
] as const;

export function SkillsInstall() {
  return (
    <CommandTabs
      tabs={tabs}
      className="not-prose my-6 w-full max-w-[640px]"
      footer={(active) => (
        <p className="mt-2 text-[12px] text-stone-500 dark:text-stone-500">{active.note}</p>
      )}
    />
  );
}
