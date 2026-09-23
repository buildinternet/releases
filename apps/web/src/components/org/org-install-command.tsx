"use client";

import { CommandSyntax } from "@/components/command-syntax";
import { CopyButton } from "@/components/ui/copy-button";

/**
 * The org-page install command pill (`$ npx @buildinternet/releases get <org>`),
 * styled with the org redesign tokens to sit beside {@link AgentCopyButton} in
 * the action row. A token-styled sibling of {@link CliCommand} (which keeps its
 * stone styling for the rest of the site).
 */
export function OrgInstallCommand({ identifier }: { identifier: string }) {
  const command = `npx @buildinternet/releases get ${identifier}`;

  return (
    <div className="flex h-[42px] w-full min-w-0 max-w-[440px] items-center gap-2.5 rounded-[10px] border border-[var(--line)] bg-[var(--surface-2)] pl-3.5 pr-1.5 sm:w-auto sm:min-w-[280px] sm:flex-1">
      <span className="select-none font-mono text-[13px] text-[var(--good)]">$</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-[var(--fg-2)]">
        <CommandSyntax command={command} />
      </code>
      <CopyButton
        text={command}
        aria-label={`Copy command: ${command}`}
        title="Copy command"
        className="h-[30px] w-[30px] rounded-[7px] text-[var(--fg-3)] hover:text-[var(--fg)] focus-visible:ring-[var(--line)] dark:text-[var(--fg-3)] dark:hover:bg-[var(--surface)] dark:hover:text-[var(--fg)] dark:focus-visible:ring-[var(--line)] hover:bg-[var(--surface)]"
      />
    </div>
  );
}
