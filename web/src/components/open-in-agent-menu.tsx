"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CopyIcon } from "@/components/copy-icon";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import {
  AGENTS,
  DEFAULT_AGENT_ID,
  type Agent,
  type AgentId,
  type AgentTarget,
} from "@/lib/agent-launch";

const STORAGE_KEY = "releases.openInAgent";

/**
 * "Open in [agent]" launcher. Attach it next to a command:
 * - `target="mcp"`: Cursor / VS Code open via deep link; Claude Code / Codex
 *   copy their `mcp add` command.
 * - `target="cli"`: every agent copies the same setup prompt (browse.sh-faithful).
 *
 * `display="menu"` (default) renders a collapsed dropdown; `display="buttons"`
 * renders an inline button row (used on docs pages for discoverability).
 */
export function OpenInAgentMenu({
  target,
  display = "menu",
  className,
}: {
  target: AgentTarget;
  display?: "menu" | "buttons";
  className?: string;
}) {
  if (display === "buttons") {
    return (
      <div className={`not-prose flex flex-wrap gap-2 ${className ?? ""}`}>
        {AGENTS.map((agent) => (
          <AgentLaunchItem key={agent.id} agent={agent} target={target} variant="button" />
        ))}
      </div>
    );
  }
  return <AgentDropdown target={target} className={className} />;
}

function AgentDropdown({ target, className }: { target: AgentTarget; className?: string }) {
  const [open, setOpen] = useState(false);
  const [remembered, setRemembered] = useState<AgentId>(DEFAULT_AGENT_ID);
  const containerRef = useRef<HTMLDivElement>(null);

  // Restore the last-picked agent (cosmetic — only the trigger icon + the row
  // check depend on it). Guarded for SSR / privacy-mode.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && AGENTS.some((a) => a.id === saved)) setRemembered(saved as AgentId);
    } catch {
      /* localStorage unavailable — keep the default */
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function remember(id: AgentId) {
    setRemembered(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
  }

  const RememberedIcon = AGENT_ICONS[remembered];

  return (
    <div ref={containerRef} className={`relative inline-flex ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Open in agent"
        title="Open in agent"
        className="inline-flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-2 text-[13px] font-medium text-stone-700 shadow-sm transition-colors hover:border-stone-300 hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:border-stone-600 dark:hover:bg-stone-800"
      >
        <span className="text-stone-600 dark:text-stone-300">
          <RememberedIcon />
        </span>
        <Chevron open={open} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-md border border-stone-200 bg-white shadow-lg dark:border-stone-800 dark:bg-stone-950"
        >
          <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500">
            Open in…
          </div>
          {AGENTS.map((agent) => (
            <AgentLaunchItem
              key={agent.id}
              agent={agent}
              target={target}
              variant="menu"
              remembered={agent.id === remembered}
              onPick={remember}
              closeMenu={() => setOpen(false)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentLaunchItem({
  agent,
  target,
  variant,
  remembered = false,
  onPick,
  closeMenu,
}: {
  agent: Agent;
  target: AgentTarget;
  variant: "menu" | "button";
  remembered?: boolean;
  onPick?: (id: AgentId) => void;
  closeMenu?: () => void;
}) {
  const action = agent[target];
  const { copied, copy } = useCopyToClipboard();
  const Icon = AGENT_ICONS[agent.id];

  const rowClass =
    variant === "menu"
      ? "flex w-full items-center gap-2 px-3 py-2 text-[13px] text-stone-700 hover:bg-stone-50 dark:text-stone-200 dark:hover:bg-stone-800"
      : "inline-flex items-center gap-2 rounded-md border border-stone-200 bg-white px-3 py-2 text-[13px] font-medium text-stone-800 shadow-sm transition-colors hover:border-stone-300 hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:hover:border-stone-600 dark:hover:bg-stone-800";

  const role = variant === "menu" ? "menuitem" : undefined;
  const content = (
    <>
      <span className="shrink-0 text-stone-600 dark:text-stone-300">
        <Icon />
      </span>
      <span className="truncate">{agent.label}</span>
      <Trailing copied={copied} remembered={variant === "menu" && remembered} />
    </>
  );

  if (action.kind === "deeplink") {
    return (
      <a
        href={action.href}
        role={role}
        onClick={() => {
          onPick?.(agent.id);
          closeMenu?.();
        }}
        className={rowClass}
      >
        {content}
      </a>
    );
  }

  // Copy commands keep the menu open so the inline "copied" state is visible.
  return (
    <button
      type="button"
      role={role}
      onClick={() => {
        copy(action.command);
        onPick?.(agent.id);
      }}
      title={copied ? "Copied — paste it in your terminal" : action.command}
      className={rowClass}
    >
      {content}
    </button>
  );
}

/** Right-aligned trailing status: the copied state wins, else the remembered check. */
function Trailing({ copied, remembered }: { copied: boolean; remembered: boolean }) {
  const inner = copied ? <CopyIcon copied size={14} /> : remembered ? <CheckMark /> : null;
  if (!inner) return null;
  return <span className="ml-auto shrink-0 text-stone-400 dark:text-stone-500">{inner}</span>;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`text-stone-400 transition-transform dark:text-stone-500 ${open ? "rotate-180" : ""}`}
    >
      <polyline points="4 6 8 10 12 6" />
    </svg>
  );
}

function CheckMark() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
    </svg>
  );
}

/** Monochrome agent marks (currentColor) keyed by agent id. */
const AGENT_ICONS: Record<AgentId, () => ReactNode> = {
  cursor: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M11.925 24l10.425-6-10.425-6L1.5 18l10.425 6z" opacity=".7" />
      <path d="M22.35 18V6L11.925 0v12l10.425 6z" opacity=".9" />
      <path d="M11.925 0L1.5 6v12l10.425-6V0z" />
    </svg>
  ),
  vscode: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z" />
    </svg>
  ),
  "claude-code": () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 1.5l1.62 6.06 4.44-4.44-2.82 5.7 6.06-1.62-5.46 3 5.46 3-6.06-1.62 2.82 5.7-4.44-4.44L12 22.5l-1.62-6.06-4.44 4.44 2.82-5.7-6.06 1.62 5.46-3-5.46-3 6.06 1.62-2.82-5.7 4.44 4.44z" />
    </svg>
  ),
  codex: () => (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 8 10 12 6 16" />
      <line x1="12.5" y1="16" x2="17" y2="16" />
    </svg>
  ),
};
