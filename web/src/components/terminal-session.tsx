"use client";

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CommandSyntax } from "@/components/command-syntax";
import { CopyIcon } from "@/components/copy-icon";
import { JsonSyntax } from "@/components/json-syntax";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

export type TerminalBlock = {
  /** Shown after a `$ ` prompt and highlighted via {@link CommandSyntax}. */
  command: string;
  /** Rendered verbatim as selectable monospace text below the command. */
  output: string;
  /**
   * Pretty-printed JSON shown in the "Agents" view. When any block provides
   * this, a Humans/Agents toggle appears; the Agents view appends `--json` to
   * the command and renders this with {@link JsonSyntax}.
   */
  json?: string;
};

type TerminalSessionProps = {
  /** Ordered command/output pairs that make up the session transcript. */
  blocks: TerminalBlock[];
  className?: string;
  /**
   * CSS length (e.g. `"26rem"`) capping the transcript height and enabling
   * internal scroll. Omit to let the panel grow with its content.
   */
  maxHeight?: string;
  /** macOS-style traffic-light dots header. Default `true`. */
  showChrome?: boolean;
  /** Copy-the-whole-transcript button. Default `true`. */
  copyable?: boolean;
  /** Accessible label for the panel region. */
  ariaLabel?: string;
  /**
   * Progressively reveal the (Humans) transcript on mount: each command types
   * out character-by-character, then its output appears line-by-line, then the
   * next command. Plays once. Honors `prefers-reduced-motion` (reveals
   * instantly). When `false` (default) the whole transcript renders at once.
   */
  animate?: boolean;
};

// Reveal cadence (ms).
const CHAR_MS = 32; // per command character typed
const AFTER_CMD_MS = 260; // pause once a command finishes typing
const LINE_MS = 70; // per output line revealed
const BETWEEN_MS = 550; // pause between blocks

type View = "human" | "agents";

type Reveal = {
  block: number;
  phase: "cmd" | "out";
  cmdChars: number;
  outLines: number;
  done: boolean;
};

/**
 * A page-agnostic, terminal-styled panel that renders a sequence of
 * `command → output` blocks as real, selectable, copyable, scrollable text.
 *
 * Presentational only: callers pass the transcript via `blocks`; nothing here
 * is specific to any one page. Shares surface tokens with `TerminalCompare`
 * for visual consistency. Pass `animate` to type the session out on mount; give
 * blocks a `json` to surface a Humans/Agents toggle.
 */
export function TerminalSession({
  blocks,
  className,
  maxHeight,
  showChrome = true,
  copyable = true,
  ariaLabel = "Example terminal session",
  animate = false,
}: TerminalSessionProps) {
  const { copied, copy } = useCopyToClipboard();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>("human");
  const [reveal, setReveal] = useState<Reveal>(() => ({
    block: 0,
    phase: "cmd",
    cmdChars: 0,
    outLines: 0,
    done: !animate,
  }));

  const hasJson = blocks.some((b) => b.json != null);
  const agentMode = view === "agents";

  const fullText = blocks
    .map((b) => {
      if (agentMode && b.json != null) return `$ ${b.command} --json\n${b.json}`;
      return b.command ? `$ ${b.command}\n${b.output}` : b.output;
    })
    .join("\n\n");

  const replay = useCallback(() => {
    // Respect reduced-motion on replay too, not just initial mount.
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setView("human");
    setReveal({ block: 0, phase: "cmd", cmdChars: 0, outLines: 0, done: reduce });
  }, []);

  // Switching views is an exploration gesture — snap the reveal to its final
  // state so we never animate or slice the JSON.
  const switchView = useCallback((next: View) => {
    setView(next);
    setReveal((r) => ({ ...r, done: true }));
  }, []);

  // Honor reduced-motion: jump straight to the fully-revealed state.
  useEffect(() => {
    if (!animate) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setReveal((r) => ({ ...r, done: true }));
    }
  }, [animate]);

  // Advance the reveal one step (a char, a line, or a block) per tick. Only the
  // Humans view animates; the Agents view always shows its full JSON.
  useEffect(() => {
    if (reveal.done || agentMode) return;
    const block = blocks[reveal.block];
    if (!block) {
      setReveal((r) => ({ ...r, done: true }));
      return;
    }
    const outputLineCount = block.output.length ? block.output.split("\n").length : 0;

    let delay: number;
    let next: Reveal;
    if (reveal.phase === "cmd") {
      if (reveal.cmdChars < block.command.length) {
        delay = CHAR_MS;
        next = { ...reveal, cmdChars: reveal.cmdChars + 1 };
      } else {
        delay = AFTER_CMD_MS;
        next = { ...reveal, phase: "out", outLines: 0 };
      }
    } else if (reveal.outLines < outputLineCount) {
      delay = LINE_MS;
      next = { ...reveal, outLines: reveal.outLines + 1 };
    } else if (reveal.block + 1 < blocks.length) {
      delay = BETWEEN_MS;
      next = { block: reveal.block + 1, phase: "cmd", cmdChars: 0, outLines: 0, done: false };
    } else {
      delay = 0;
      next = { ...reveal, done: true };
    }

    const id = setTimeout(() => setReveal(next), delay);
    return () => clearTimeout(id);
  }, [reveal, blocks, agentMode]);

  // Keep the active line in view while revealing.
  useEffect(() => {
    if (reveal.done || agentMode) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reveal, agentMode]);

  // Fixed height *while animating* avoids layout shift as content fills in; once
  // the reveal is done we drop back to the `maxHeight` cap so the panel can size
  // to its content (and the value matches, so it never jumps).
  const scrollerStyle = maxHeight
    ? animate && !reveal.done
      ? { height: maxHeight }
      : { maxHeight }
    : undefined;

  const caretVisible = !agentMode && !reveal.done;
  const showFooter = hasJson || animate;
  const showReplay = animate && reveal.done && !agentMode;

  return (
    <section
      aria-label={ariaLabel}
      className={`group relative overflow-hidden rounded-lg border border-stone-200 bg-stone-100 shadow-sm dark:border-stone-800 dark:bg-[oklch(0.268_0.007_286.3)] ${className ?? ""}`}
    >
      {showChrome && (
        <div
          aria-hidden
          className="flex items-center gap-2 border-b border-stone-200/70 px-4 py-3 dark:border-stone-800/60"
        >
          <span className="h-3 w-3 rounded-full bg-stone-300 dark:bg-stone-600" />
          <span className="h-3 w-3 rounded-full bg-stone-300 dark:bg-stone-600" />
          <span className="h-3 w-3 rounded-full bg-stone-300 dark:bg-stone-600" />
        </div>
      )}

      {copyable && (
        <button
          type="button"
          onClick={() => copy(fullText)}
          aria-label={copied ? "Copied" : "Copy to clipboard"}
          className="absolute top-2 right-2 z-10 rounded-md p-1.5 text-stone-400 opacity-0 transition-opacity hover:bg-stone-200 hover:text-stone-700 focus-visible:opacity-100 group-hover:opacity-100 dark:text-stone-500 dark:hover:bg-stone-800 dark:hover:text-stone-200"
        >
          <CopyIcon copied={copied} size={14} />
        </button>
      )}

      <div ref={scrollerRef} className="overflow-auto" style={scrollerStyle}>
        <pre className="m-0 !bg-transparent p-4 pr-12 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words text-stone-600 dark:text-stone-300">
          {blocks.map((block, bi) => {
            if (agentMode) {
              return (
                <Fragment key={bi}>
                  {bi > 0 && "\n\n"}
                  {block.command && (
                    <>
                      <span className="select-none text-stone-400 dark:text-stone-600">$ </span>
                      <CommandSyntax command={`${block.command} --json`} />
                    </>
                  )}
                  {block.json != null && (
                    <>
                      {block.command ? "\n" : null}
                      <JsonSyntax json={block.json} />
                    </>
                  )}
                </Fragment>
              );
            }

            const fullyRevealed = reveal.done || bi < reveal.block;
            if (!fullyRevealed && bi > reveal.block) return null; // not started yet

            const inOutputPhase = !reveal.done && bi === reveal.block && reveal.phase === "out";
            const commandText =
              fullyRevealed || inOutputPhase
                ? block.command
                : block.command.slice(0, reveal.cmdChars);
            const showOutput = fullyRevealed || inOutputPhase;
            const outputText = !showOutput
              ? null
              : fullyRevealed
                ? block.output
                : block.output.split("\n").slice(0, reveal.outLines).join("\n");

            return (
              <Fragment key={bi}>
                {bi > 0 && "\n\n"}
                {block.command && (
                  <>
                    <span className="select-none text-stone-400 dark:text-stone-600">$ </span>
                    <CommandSyntax command={commandText} />
                  </>
                )}
                {outputText !== null && (
                  <>
                    {block.command ? "\n" : null}
                    <OutputText text={outputText} />
                  </>
                )}
              </Fragment>
            );
          })}
          {caretVisible && (
            <span aria-hidden className="terminal-caret text-stone-400 dark:text-stone-500">
              ▋
            </span>
          )}
        </pre>
      </div>

      {showFooter && (
        <div className="flex items-center justify-between border-t border-stone-200/70 px-3 py-2 dark:border-stone-800/60">
          {hasJson ? (
            <div
              role="group"
              aria-label="Output format"
              className="inline-flex items-center gap-0.5 rounded-full bg-stone-200/70 p-0.5 dark:bg-black/30"
            >
              {(
                [
                  ["human", "Humans"],
                  ["agents", "Agents"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={view === value}
                  onClick={() => switchView(value)}
                  className={`rounded-full px-2.5 py-0.5 font-mono text-[12px] transition-colors ${
                    view === value
                      ? "bg-white text-stone-900 shadow-sm dark:bg-stone-700 dark:text-stone-100"
                      : "text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : (
            <span />
          )}
          {showReplay && (
            <button
              type="button"
              onClick={replay}
              aria-label="Replay animation"
              className="rounded-md p-1 text-stone-400 transition-colors hover:bg-stone-200 hover:text-stone-700 dark:text-stone-500 dark:hover:bg-stone-800 dark:hover:text-stone-200"
            >
              <ReplayIcon size={14} />
            </button>
          )}
        </div>
      )}
    </section>
  );
}

const ID_TOKEN = /(?:rel|org|src|prod)_[A-Za-z0-9_-]+/g;

/**
 * Renders human output, dimming any typed IDs (`rel_…`, `org_…`, …) the way the
 * CLI does — the lookup handle stays present and copyable, but subordinate to
 * the titles and summaries.
 */
function OutputText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(ID_TOKEN)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push(<Fragment key={key++}>{text.slice(last, idx)}</Fragment>);
    parts.push(
      <span key={key++} className="text-stone-400 dark:text-stone-500">
        {m[0]}
      </span>,
    );
    last = idx + m[0].length;
  }
  if (last < text.length) parts.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return <>{parts}</>;
}

function ReplayIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <polyline points="13.8 2.5 12 4.3 9.7 4.1" />
    </svg>
  );
}
