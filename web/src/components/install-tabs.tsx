"use client";

import { useState, useRef, useCallback, useEffect } from "react";

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
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);

  const current = tabs.find((t) => t.id === active)!;

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(current.command);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }, [current.command]);

  return (
    <div className="w-full max-w-[540px] mx-auto">
      <div className="flex border-b border-stone-200 dark:border-stone-700">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => { setActive(tab.id); setCopied(false); }}
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
        onClick={copy}
        className="bg-stone-100 dark:bg-stone-900 border border-t-0 border-stone-200 dark:border-stone-700 rounded-b-lg px-4 py-3 flex items-center justify-between gap-3 cursor-pointer hover:bg-stone-200 dark:hover:bg-stone-800/80 transition-colors"
      >
        <code className="text-[13px] font-mono text-stone-700 dark:text-stone-300 overflow-x-auto whitespace-nowrap pointer-events-none">
          {current.command}
        </code>
        <span className="shrink-0 p-1.5 text-stone-400 dark:text-stone-500">
          {copied ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
              <path d="M10.5 5.5V3.5a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2" />
            </svg>
          )}
        </span>
      </div>
    </div>
  );
}
