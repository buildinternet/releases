"use client";

import { CommandSyntax } from "@/components/command-syntax";
import { CopyIcon } from "@/components/copy-icon";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

/**
 * The org-page install command pill (`$ npx @buildinternet/releases get <org>`),
 * styled with the org redesign tokens to sit beside {@link AgentCopyButton} in
 * the action row. A token-styled sibling of {@link CliCommand} (which keeps its
 * stone styling for the rest of the site).
 */
export function OrgInstallCommand({ identifier }: { identifier: string }) {
  const { copied, copy } = useCopyToClipboard();
  const command = `npx @buildinternet/releases get ${identifier}`;

  return (
    <div className="flex h-[42px] w-full min-w-0 max-w-[440px] items-center gap-2.5 rounded-[10px] border border-[var(--line)] bg-[var(--surface-2)] pl-3.5 pr-1.5 sm:w-auto sm:min-w-[280px] sm:flex-1">
      <span className="select-none font-mono text-[13px] text-[var(--good)]">$</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-[var(--fg-2)]">
        <CommandSyntax command={command} />
      </code>
      <button
        type="button"
        onClick={() => copy(command)}
        aria-label={copied ? "Copied" : `Copy command: ${command}`}
        title={copied ? "Copied" : "Copy command"}
        className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[7px] text-[var(--fg-3)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--fg)]"
      >
        <CopyIcon copied={copied} size={15} />
      </button>
    </div>
  );
}
