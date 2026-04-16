"use client";

import { useState } from "react";
import { CopyIcon } from "@/components/copy-icon";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

type TerminalPane = {
  label: string;
  badge?: string;
  command: string;
  output: string;
};

export function TerminalCompare({ panes }: { panes: TerminalPane[] }) {
  const [active, setActive] = useState(0);
  const { copied, copy } = useCopyToClipboard();

  const current = panes[active];
  const fullText = current.command
    ? `$ ${current.command}\n${current.output}`
    : current.output;

  return (
    <div className="not-prose my-8">
      <div className="flex border-b border-stone-200 dark:border-stone-700">
        {panes.map((pane, i) => (
          <button
            key={pane.label}
            onClick={() => setActive(i)}
            className={`px-4 py-2 text-[13px] font-mono font-medium transition-colors ${
              active === i
                ? "text-stone-900 dark:text-stone-100 border-b-2 border-stone-900 dark:border-stone-100 -mb-px"
                : "text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300"
            }`}
          >
            {pane.label}
            {pane.badge && (
              <span className="ml-2 text-[11px] text-stone-400 dark:text-stone-500">
                {pane.badge}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="group relative rounded-b-lg bg-stone-950 border border-t-0 border-stone-800 max-h-[400px] flex flex-col overflow-hidden">
        <div className="flex items-center gap-1.5 px-3.5 py-2.5 border-b border-stone-800 shrink-0">
          <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
        </div>
        <div className="p-4 overflow-auto min-h-0">
          <pre className="text-[13px] leading-relaxed font-mono">
            {current.command && (
              <>
                <span className="text-stone-500">$ </span>
                <span className="text-stone-300">{current.command}</span>
                {"\n"}
              </>
            )}
            <span className="text-stone-400">{current.output}</span>
          </pre>
        </div>
        <button
          type="button"
          onClick={() => copy(fullText)}
          aria-label={copied ? "Copied" : "Copy to clipboard"}
          className="absolute top-10 right-2 p-1.5 rounded-md text-stone-400 dark:text-stone-500 opacity-0 group-hover:opacity-100 hover:text-stone-300 hover:bg-stone-800 transition-opacity"
        >
          <CopyIcon copied={copied} size={14} />
        </button>
      </div>
    </div>
  );
}
