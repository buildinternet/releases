"use client";

import { CopyIcon } from "@/components/copy-icon";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

type TerminalPane = {
  label: string;
  badge?: string;
  command: string;
  output: string;
};

function Pane({ pane }: { pane: TerminalPane }) {
  const { copied, copy } = useCopyToClipboard();
  const fullText = `$ ${pane.command}\n${pane.output}`;

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 mb-2">
        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[12px] font-mono font-medium bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300">
          {pane.label}
        </span>
        {pane.badge && (
          <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[12px] font-mono text-stone-400 dark:text-stone-500 bg-stone-100 dark:bg-stone-800">
            {pane.badge}
          </span>
        )}
      </div>
      <div className="group relative rounded-lg bg-stone-950 border border-stone-800 max-h-[320px] flex flex-col overflow-hidden">
        <div className="flex items-center gap-1.5 px-3.5 py-2.5 border-b border-stone-800 shrink-0">
          <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
        </div>
        <div className="p-4 overflow-auto min-h-0">
          <pre className="text-[13px] leading-relaxed font-mono">
            <span className="text-stone-500">$ </span>
            <span className="text-stone-300">{pane.command}</span>
            {"\n"}
            <span className="text-stone-400">{pane.output}</span>
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

export function TerminalCompare({ panes }: { panes: [TerminalPane, TerminalPane] }) {
  return (
    <div className="not-prose grid grid-cols-1 md:grid-cols-2 items-start gap-4 my-8">
      <Pane pane={panes[0]} />
      <Pane pane={panes[1]} />
    </div>
  );
}
