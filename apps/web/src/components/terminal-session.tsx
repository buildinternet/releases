"use client";

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CommandSyntax } from "@/components/command-syntax";
import { CopyIcon } from "@/components/copy-icon";
import { JsonSyntax } from "@/components/json-syntax";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import { nextTabIndex } from "@/components/terminal-tab-nav";

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

/** One use-case tab: a label and its own command/output transcript. */
export type TerminalTab = { id: string; label: string; blocks: TerminalBlock[] };

type TerminalSessionProps = {
  /**
   * Ordered command/output pairs that make up the session transcript. Optional
   * when `tabs` is provided (each tab carries its own blocks); supply one or the
   * other.
   */
  blocks?: TerminalBlock[];
  /**
   * Optional use-case tabs. When provided, a tab row replaces the traffic-light
   * chrome and the component renders the active tab's transcript; the `blocks`
   * prop is ignored. The Humans/Agents toggle and replay operate on the active
   * tab.
   */
  tabs?: TerminalTab[];
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
  blocks = [],
  tabs,
  className,
  maxHeight,
  showChrome = true,
  copyable = true,
  ariaLabel = "Example terminal session",
  animate = false,
}: TerminalSessionProps) {
  const { copied, copy } = useCopyToClipboard();
  const [activeTab, setActiveTab] = useState(0);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>("human");
  const [reveal, setReveal] = useState<Reveal>(() => ({
    block: 0,
    phase: "cmd",
    cmdChars: 0,
    outLines: 0,
    done: !animate,
  }));

  // When `tabs` is provided, the active tab drives everything below; the
  // `blocks` prop is the single-transcript fallback. `tabs[activeTab]` is a
  // stable reference, so `activeBlocks` is safe in effect deps.
  const activeTabMeta = tabs?.[activeTab];
  const activeBlocks = activeTabMeta?.blocks ?? blocks;
  const hasJson = activeBlocks.some((b) => b.json != null);
  const agentMode = view === "agents";

  // With tabs, the active tab's tabpanel is already named by its tab button, so
  // the section stays unlabeled — avoids a redundant region landmark wrapping it.
  const sectionLabel = activeTabMeta ? undefined : ariaLabel;

  const fullText = activeBlocks
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

  // Switching use-case tabs snaps the new transcript to its final state (no
  // re-typing) and preserves the Humans/Agents selection.
  const switchTab = useCallback((next: number) => {
    setActiveTab(next);
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
    const block = activeBlocks[reveal.block];
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
    } else if (reveal.block + 1 < activeBlocks.length) {
      delay = BETWEEN_MS;
      next = { block: reveal.block + 1, phase: "cmd", cmdChars: 0, outLines: 0, done: false };
    } else {
      delay = 0;
      next = { ...reveal, done: true };
    }

    const id = setTimeout(() => setReveal(next), delay);
    return () => clearTimeout(id);
  }, [reveal, activeBlocks, agentMode]);

  // Keep the active line in view while revealing.
  useEffect(() => {
    if (reveal.done || agentMode) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reveal, agentMode]);

  // `maxHeight` is a plain cap: the reveal never changes the panel's height
  // (unrevealed text stays in the layout as invisible spans, below), so the
  // box is content-sized from the first frame and never jumps.
  const scrollerStyle = maxHeight ? { maxHeight } : undefined;

  const caretVisible = !agentMode && !reveal.done;
  // With tabs, the Humans/Agents toggle lives in the tab bar; the footer only
  // exists to host the toggle (tabless) or the replay affordance.
  const footerToggle = hasJson && !(tabs && tabs.length > 0);
  const showFooter = footerToggle || animate;
  const showReplay = animate && reveal.done && !agentMode;

  return (
    <section
      aria-label={sectionLabel}
      className={`group relative overflow-hidden rounded-lg border border-stone-200 bg-stone-100 shadow-sm dark:border-stone-800 dark:bg-[oklch(0.268_0.007_286.3)] ${className ?? ""}`}
    >
      {tabs && tabs.length > 0 ? (
        <TabBar
          tabs={tabs}
          active={activeTab}
          onSelect={switchTab}
          trailing={hasJson ? <ViewToggle view={view} onChange={switchView} /> : undefined}
        />
      ) : (
        showChrome && (
          <div
            aria-hidden
            className="flex items-center gap-2 border-b border-stone-200/70 px-4 py-3 dark:border-stone-800/60"
          >
            <span className="h-3 w-3 rounded-full bg-stone-300 dark:bg-stone-600" />
            <span className="h-3 w-3 rounded-full bg-stone-300 dark:bg-stone-600" />
            <span className="h-3 w-3 rounded-full bg-stone-300 dark:bg-stone-600" />
          </div>
        )
      )}

      {copyable && (
        <button
          type="button"
          onClick={() => copy(fullText)}
          aria-label={copied ? "Copied" : "Copy to clipboard"}
          // With tabs the top-right corner belongs to the humans/agents
          // toggle, so the copy affordance drops just below the tab bar.
          className={`absolute ${tabs && tabs.length > 0 ? "top-12" : "top-2"} right-2 z-10 rounded-md p-1.5 text-stone-400 opacity-0 transition-opacity hover:bg-stone-200 hover:text-stone-700 focus-visible:opacity-100 group-hover:opacity-100 dark:text-stone-500 dark:hover:bg-stone-800 dark:hover:text-stone-200`}
        >
          <CopyIcon copied={copied} size={14} />
        </button>
      )}

      <div
        ref={scrollerRef}
        className="overflow-auto"
        style={scrollerStyle}
        role={activeTabMeta ? "tabpanel" : undefined}
        id={activeTabMeta ? `terminal-tabpanel-${activeTabMeta.id}` : undefined}
        aria-labelledby={activeTabMeta ? `terminal-tab-${activeTabMeta.id}` : undefined}
      >
        <pre className="m-0 !bg-transparent p-4 pr-12 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words text-stone-600 dark:text-stone-300">
          {activeBlocks.map((block, bi) => {
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

            // The reveal must never change the panel's geometry: text that
            // hasn't been "typed" yet still renders, wrapped in an invisible
            // span, so the transcript occupies its final height (and line
            // wraps) from the first frame. Revealing swaps visibility only —
            // no layout shift when the animation ends. The caret rides inline
            // at the visible/invisible boundary.
            const fullyRevealed = reveal.done || bi < reveal.block;

            if (fullyRevealed) {
              return (
                <Fragment key={bi}>
                  {bi > 0 && "\n\n"}
                  {block.command && (
                    <>
                      <span className="select-none text-stone-400 dark:text-stone-600">$ </span>
                      <CommandSyntax command={block.command} />
                    </>
                  )}
                  {block.command ? "\n" : null}
                  <OutputText text={block.output} />
                </Fragment>
              );
            }

            if (bi > reveal.block) {
              // Not started: hold the block's full footprint invisibly.
              return (
                <Fragment key={bi}>
                  {bi > 0 && "\n\n"}
                  <span aria-hidden className="invisible">
                    {block.command ? `$ ${block.command}\n` : ""}
                    {block.output}
                  </span>
                </Fragment>
              );
            }

            // The block mid-reveal: visible slice, caret, invisible remainder.
            const typing = reveal.phase === "cmd";
            const typedCmd = typing ? block.command.slice(0, reveal.cmdChars) : block.command;
            const lines = block.output.split("\n");
            const visibleOut = typing ? "" : lines.slice(0, reveal.outLines).join("\n");
            const hiddenOut = typing ? block.output : lines.slice(reveal.outLines).join("\n");
            const hiddenText = typing
              ? `${block.command.slice(reveal.cmdChars)}\n${block.output}`
              : `${visibleOut && hiddenOut ? "\n" : ""}${hiddenOut}`;

            return (
              <Fragment key={bi}>
                {bi > 0 && "\n\n"}
                {block.command && (
                  <>
                    <span className="select-none text-stone-400 dark:text-stone-600">$ </span>
                    <CommandSyntax command={typedCmd} />
                  </>
                )}
                {!typing && (block.command ? "\n" : null)}
                {visibleOut !== "" && <OutputText text={visibleOut} />}
                {caretVisible && (
                  <span aria-hidden className="terminal-caret text-stone-400 dark:text-stone-500">
                    ▋
                  </span>
                )}
                <span aria-hidden className="invisible">
                  {hiddenText}
                </span>
              </Fragment>
            );
          })}
        </pre>
      </div>

      {showFooter && (
        <div className="flex items-center justify-between border-t border-stone-200/70 px-3 py-2 dark:border-stone-800/60">
          {footerToggle ? (
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
          {/* Reserved (invisible) rather than unmounted while the reveal
              runs, so the footer — and with it the whole panel — keeps a
              constant height when the button appears. */}
          {animate && (
            <button
              type="button"
              onClick={replay}
              aria-label="Replay animation"
              aria-hidden={!showReplay}
              disabled={!showReplay}
              tabIndex={showReplay ? undefined : -1}
              className={`rounded-md p-1 text-stone-400 transition-colors hover:bg-stone-200 hover:text-stone-700 dark:text-stone-500 dark:hover:bg-stone-800 dark:hover:text-stone-200 ${
                showReplay ? "" : "invisible"
              }`}
            >
              <ReplayIcon size={14} />
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Use-case tab row that replaces the traffic-light chrome. Presentation +
 * keyboard navigation only (WAI-ARIA tabs pattern); the parent owns active
 * state. Scrolls horizontally rather than wrapping on narrow viewports.
 */
function TabBar({
  tabs,
  active,
  onSelect,
  trailing,
}: {
  tabs: TerminalTab[];
  active: number;
  onSelect: (i: number) => void;
  /**
   * Optional right-aligned control (the humans/agents toggle). Rendered as a
   * sibling of the tablist — not inside it — so the roving arrow-key handler
   * never fires while the control has focus. (The copy button vacates this
   * corner when tabs are present.)
   */
  trailing?: ReactNode;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div
      className={`flex items-center border-b border-stone-200/70 dark:border-stone-800/60 ${trailing ? "gap-2 pr-3" : ""}`}
    >
      <div
        role="tablist"
        aria-label="Use cases"
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-2 py-1.5"
        onKeyDown={(e) => {
          const next = nextTabIndex(active, e.key, tabs.length);
          if (next == null) return;
          e.preventDefault();
          onSelect(next);
          refs.current[next]?.focus();
        }}
      >
        {tabs.map((tab, i) => {
          const selected = i === active;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`terminal-tab-${tab.id}`}
              aria-selected={selected}
              // Only the active panel is rendered, so reference it only from the
              // selected tab — inactive tabs omit aria-controls rather than point
              // at an absent element (it's optional in the WAI-ARIA tabs pattern).
              aria-controls={selected ? `terminal-tabpanel-${tab.id}` : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(i)}
              // Sans (not mono) keeps four question-length labels on one row
              // at the demo's max-w-3xl width; the row still scrolls on mobile.
              className={`shrink-0 rounded-md px-1.5 py-1 text-[12px] whitespace-nowrap transition-colors ${
                selected
                  ? "bg-white font-medium text-stone-900 shadow-sm dark:bg-stone-700 dark:text-stone-100"
                  : "text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {trailing}
    </div>
  );
}

/**
 * Compact `humans / agents` view toggle that sits at the right edge of the tab
 * bar (mirroring the CLI's own dual audience). Plain mono words with a slash —
 * the active side carries the ink.
 */
function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const option = (value: View, label: string) => (
    <button
      type="button"
      aria-pressed={view === value}
      onClick={() => onChange(value)}
      className={`transition-colors ${
        view === value
          ? "text-stone-900 dark:text-stone-100"
          : "text-stone-400 hover:text-stone-700 dark:text-stone-500 dark:hover:text-stone-300"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div
      role="group"
      aria-label="Output format"
      className="flex shrink-0 items-center gap-1.5 font-mono text-[11px]"
    >
      {option("human", "humans")}
      <span aria-hidden className="select-none text-stone-300 dark:text-stone-600">
        /
      </span>
      {option("agents", "agents")}
    </div>
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
