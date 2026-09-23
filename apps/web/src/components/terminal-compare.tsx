"use client";

import { useState } from "react";
import { CopyButton } from "@/components/ui/copy-button";

type TerminalPane = {
  label: string;
  command: string;
  output: string;
  tokens?: number;
};

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

export function TerminalCompare({ panes }: { panes: TerminalPane[] }) {
  const [active, setActive] = useState(0);

  const current = panes[active];
  const fullText = current.command ? `$ ${current.command}\n${current.output}` : current.output;

  return (
    <div className="not-prose my-8">
      <div className="mb-3 flex items-center gap-2">
        <div
          role="tablist"
          aria-label="Output format"
          className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-stone-100 p-0.5 dark:border-stone-800 dark:bg-stone-900"
        >
          {panes.map((pane, i) => (
            <button
              key={pane.label}
              role="tab"
              aria-selected={active === i}
              onClick={() => setActive(i)}
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[12px] transition-colors ${
                active === i
                  ? "bg-white text-stone-900 shadow-sm dark:bg-stone-800 dark:text-stone-100"
                  : "text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200"
              }`}
            >
              {pane.label}
            </button>
          ))}
        </div>
        {current.tokens !== undefined && (
          <span className="inline-flex items-center rounded-full border border-stone-200 px-2 py-1 font-mono text-[11px] text-stone-500 dark:border-stone-800 dark:text-stone-400">
            ~{formatTokens(current.tokens)} tokens
          </span>
        )}
      </div>
      <div className="group relative overflow-hidden rounded-md border border-stone-200 bg-stone-100 dark:border-stone-800 dark:bg-[oklch(0.268_0.007_286.3)]">
        <CopyButton
          text={fullText}
          className="absolute top-2 right-2 opacity-0 transition-opacity hover:bg-stone-200 group-hover:opacity-100 focus-visible:opacity-100 dark:hover:bg-stone-800"
        />
        <div className="overflow-x-auto">
          <pre className="m-0 !border-0 !bg-transparent p-4 pr-12 font-mono text-[13px] leading-relaxed">
            {current.command && (
              <>
                <span className="select-none text-stone-400 dark:text-stone-600">$ </span>
                <span className="text-stone-800 dark:text-stone-200">{current.command}</span>
                {"\n"}
              </>
            )}
            <span className="text-stone-600 dark:text-stone-400">{current.output}</span>
          </pre>
        </div>
      </div>
    </div>
  );
}
