"use client";

import { useState } from "react";
import { CopyIcon } from "@/components/copy-icon";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

const cliOptions = [
  { id: "npm", label: "npm", command: "npm install -g @buildinternet/releases" },
  { id: "homebrew", label: "Homebrew", command: "brew install buildinternet/tap/releases" },
  { id: "shell", label: "Shell", command: "curl -fsSL https://releases.sh/install | bash" },
] as const;
type CliId = (typeof cliOptions)[number]["id"];

const MCP_URL = "https://mcp.releases.sh/mcp";
const SKILL_CMD = "npx skills add buildinternet/releases-cli";

const HELP = {
  cli: { text: "Query releases from your terminal.", href: "/docs/cli/browsing" },
  mcp: { text: "Add the URL to any MCP-compatible client.", href: "/docs/api/mcp" },
  skill: {
    text: "Teaches coding agents how to look up releases on demand.",
    href: "/docs/skills",
  },
} as const;
type TopId = keyof typeof HELP;

const TOP_TABS = [
  { id: "cli", label: "CLI" },
  { id: "mcp", label: "MCP" },
  { id: "skill", label: "Skill" },
] as const;

function CodeBlock({
  command,
  variant = "boxed",
}: {
  command: string;
  variant?: "boxed" | "inline";
}) {
  const { copied, copy } = useCopyToClipboard();
  const surface =
    variant === "inline"
      ? "bg-stone-100 dark:bg-stone-900 border border-stone-200 dark:border-stone-700"
      : "bg-white dark:bg-stone-950 border border-stone-200 dark:border-stone-800";
  return (
    <div
      onClick={() => copy(command)}
      className={`${surface} rounded px-3 py-2 flex items-center justify-between gap-2 cursor-pointer hover:border-stone-300 dark:hover:border-stone-700 transition-colors`}
    >
      <code className="text-[12px] font-mono text-stone-700 dark:text-stone-300 overflow-x-auto whitespace-nowrap pointer-events-none">
        {command}
      </code>
      <span className="shrink-0 text-stone-400 dark:text-stone-500">
        <CopyIcon copied={copied} size={14} />
      </span>
    </div>
  );
}

function CliMiniTabs({ cli, setCli }: { cli: CliId; setCli: (id: CliId) => void }) {
  return (
    <div className="flex gap-1 text-[12px]">
      {cliOptions.map((opt) => (
        <button
          key={opt.id}
          onClick={() => setCli(opt.id)}
          className={`px-2 py-1 rounded transition-colors ${
            cli === opt.id
              ? "bg-stone-200 dark:bg-stone-800 text-stone-900 dark:text-stone-100"
              : "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function InstallStepsInline() {
  const [top, setTop] = useState<TopId>("cli");
  const [cli, setCli] = useState<CliId>("npm");
  const cliCmd = cliOptions.find((c) => c.id === cli)!.command;
  const cmd = top === "cli" ? cliCmd : top === "mcp" ? MCP_URL : SKILL_CMD;

  return (
    <div className="text-left w-full max-w-[540px] mx-auto">
      <div className="text-center text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-3">
        Get Started
      </div>
      <div className="flex border-b border-stone-200 dark:border-stone-700">
        {TOP_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTop(t.id)}
            className={`px-4 py-2 text-[13px] font-medium transition-colors ${
              top === t.id
                ? "text-stone-900 dark:text-stone-100 border-b-2 border-stone-900 dark:border-stone-100 -mb-px"
                : "text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-3 space-y-2">
        {top === "cli" && <CliMiniTabs cli={cli} setCli={setCli} />}
        <CodeBlock command={cmd} variant="inline" />
        <p className="text-[12px] leading-snug text-stone-500 dark:text-stone-400">
          {HELP[top].text} <DocsLink href={HELP[top].href} />
        </p>
      </div>
    </div>
  );
}

function DocsLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      className="text-stone-700 dark:text-stone-300 underline decoration-stone-300 dark:decoration-stone-700 underline-offset-2 hover:decoration-stone-500 dark:hover:decoration-stone-400 transition-colors"
    >
      Learn more →
    </a>
  );
}

function StepHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-700 dark:text-stone-300">
      {children}
    </div>
  );
}

function StepHelp({ children, href }: { children: React.ReactNode; href: string }) {
  return (
    <p className="text-[12px] leading-snug text-stone-500 dark:text-stone-400">
      {children} <DocsLink href={href} />
    </p>
  );
}

export function InstallStepsSidebar() {
  const [cli, setCli] = useState<CliId>("npm");
  const cliCmd = cliOptions.find((c) => c.id === cli)!.command;

  return (
    <div className="text-left bg-stone-50 dark:bg-stone-900/40 border border-stone-200 dark:border-stone-800 rounded-lg p-5 space-y-5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 dark:text-stone-500">
        Get Started
      </div>

      <section className="space-y-2">
        <StepHeading>Install the CLI</StepHeading>
        <CliMiniTabs cli={cli} setCli={setCli} />
        <CodeBlock command={cliCmd} />
        <StepHelp href={HELP.cli.href}>{HELP.cli.text}</StepHelp>
      </section>

      <div className="border-t border-stone-200 dark:border-stone-800" />

      <section className="space-y-2">
        <StepHeading>Or connect via MCP</StepHeading>
        <CodeBlock command={MCP_URL} />
        <StepHelp href={HELP.mcp.href}>{HELP.mcp.text}</StepHelp>
      </section>

      <div className="border-t border-stone-200 dark:border-stone-800" />

      <section className="space-y-2">
        <StepHeading>Add the agent skill</StepHeading>
        <CodeBlock command={SKILL_CMD} />
        <StepHelp href={HELP.skill.href}>{HELP.skill.text}</StepHelp>
      </section>
    </div>
  );
}
