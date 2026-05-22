# 2026-05-22 — `TerminalSession`: reusable terminal demo component

## Problem

The home page describes Releases as "an agent-friendly API for product changelogs" but never _shows_ the CLI in action. Reference point: [agents.ramp.com](https://agents.ramp.com/) opens with a polished, terminal-styled panel that demos their CLI's output. We want a comparable centerpiece on our home page — but built as a **reusable component**, since the home page is just the first of likely several places we'll want to show off CLI output.

What made the Ramp element effective (and what we're matching):

- A clean, terminal-framed presentation of real command output.
- Output is **real, selectable, copyable text** — you can scroll through it and select/copy, not an image or canvas.
- macOS-style window chrome (traffic-light dots) for polish.

What we are **not** matching: Ramp's element is interactive (typed input, a command registry, `help`) but backed by **mocked data**. We don't need interactivity, and our output will be drawn from the _real_ CLI rather than faked.

## Goals

- A reusable, page-agnostic `TerminalSession` component that renders a sequence of `command → output` blocks in a terminal frame.
- Output text is fully selectable, copyable (native selection + a copy-all button), and scrollable (internal scroll when capped).
- Visually consistent with the existing `TerminalCompare` component used in the docs.
- Used on the home page as the centerpiece: placed above the existing ticker so it pushes the rest of the page down.
- No new runtime dependencies.

## Non-goals (YAGNI)

- **Interactivity** — no typed input, command registry, or `help`. The transcript is fixed.
- **ANSI parsing** — content is authored as styled data, not piped through an ANSI→HTML converter.
- **Live API calls** — content is a curated static snapshot, not fetched at request time.
- **Refactoring `TerminalCompare`** — left untouched; the two stay independent but share surface tokens.

Two items the first draft listed as non-goals were added during implementation and are now part of the contract: a play-once **typing/playback animation** (`animate` prop, honors `prefers-reduced-motion`) and a **Humans/Agents output toggle** (a block may carry a `json` string; the Agents view appends `--json` and renders it syntax-highlighted).

## Future work (noted, not in scope)

- **asciinema playback variant.** The user is interested in a future iteration that embeds [`asciinema-player`](https://docs.asciinema.org/manual/player/) playing a recorded real `releases` session (autoplay + scrub bar, real ANSI, still selectable DOM text). This would be a separate, additive component/mode — it does not block or alter this static component.
- If a second page reuses the _same_ command sequence, promote the curated content to a small shared data module (e.g. `web/src/lib/demo-sessions.ts`). Not done now (single consumer).
- If `TerminalSession` and `TerminalCompare` clearly converge, extract a shared `TerminalFrame` (chrome + surface + copy). Deferred — no need yet.

## Design

### Component: `web/src/components/terminal-session.tsx`

A `"use client"` component (client only because of the copy button; the markup itself is static and SSR-renders). It is purely presentational — it takes its content via props and hardcodes nothing page-specific.

```ts
type TerminalBlock = {
  command: string; // shown after a "$ " prompt, highlighted via CommandSyntax
  output: string; // rendered verbatim as selectable monospace text
  json?: string; // optional pretty-printed JSON for the "Agents" view; presence enables the Humans/Agents toggle
};

type TerminalSessionProps = {
  blocks: TerminalBlock[];
  className?: string;
  maxHeight?: string; // e.g. "26rem" — caps height and enables internal vertical scroll. Omit → grows naturally.
  showChrome?: boolean; // macOS traffic-light dots header, default true
  copyable?: boolean; // copy-all button, default true
  ariaLabel?: string; // accessible label for the panel region
  animate?: boolean; // play-once typed reveal on mount (honors prefers-reduced-motion), default false
};
```

Structure (reusing `TerminalCompare`'s surface classes for visual consistency):

- Outer panel: `rounded-md border`, terminal surface background — light `bg-stone-100`, dark `bg-[oklch(0.268_0.007_286.3)]` (the exact tokens `TerminalCompare` already uses). Theme-adaptive (matches `TerminalCompare`), not dark-always.
- Optional header bar with three traffic-light dots (`aria-hidden`, decorative) when `showChrome`.
- Copy-all button (when `copyable`): top-right, appears on hover, copies the full transcript as plain text (`$ <command>\n<output>` per block, blocks joined by a blank line). Reuses `useCopyToClipboard` + `CopyIcon`.
- Body: a single `<pre>` containing the blocks in order. Each block: a prompt span (a `"$"` token plus a trailing space, `select-none`) + the command highlighted with `CommandSyntax`, a newline, then the output in a muted token color (typed IDs like `rel_…` are dimmed). Blocks separated by a blank line.
- Scroll/wrap: the `<pre>` uses `whitespace-pre-wrap break-words` so long real lines (full ISO timestamps, content excerpts, URLs) wrap like a terminal rather than clipping horizontally. When `maxHeight` is set, the body gets `overflow-y-auto` with that cap for internal vertical scroll.

### Content (home page)

The curated command sequence lives **at the call site in `web/src/app/page.tsx`** as a `const`, passed as `blocks`. Two blocks, faithful to real captured CLI output (only the env-warning line is stripped; commands, values, IDs, and AI summaries are real):

1. `releases search "webhooks" --type releases` — a cross-vendor "who shipped webhooks" result (Axiom, Gemini, Resend), each row carrying its dimmed `rel_…` handle and a content excerpt. The Agents view shows the real `--json` payload (full `content` included).
2. `releases get rel_…` — drills into one of those hits by ID, showing the record + AI summary; the Agents view shows the full real object.

The human-readable `search`/`get` formatting the CLI prints today is rough (verbose source lines, full ISO timestamps); a future CLI formatting pass is tracked in [buildinternet/releases-cli#215](https://github.com/buildinternet/releases-cli/issues/215), which captured an earlier, more polished column layout from a draft of this demo as the target. Until that lands, the transcript stays accurate to shipped output. `maxHeight` keeps the panel from dominating beyond the first viewport while remaining scrollable, and the demo is wrapped in `data-nosnippet` so its example text doesn't feed search snippets.

### Placement (`web/src/app/page.tsx`)

Insert the `<TerminalSession>` between the hero text block (`<h1>` + subhead + stats + mobile `InstallStepsInline`) and `<ShippingNowTicker>`. Centered, constrained width (e.g. `max-w-3xl mx-auto px-6`) so it reads as the focal element. This pushes the ticker, featured collections, and org table down — satisfying "make it the centerpiece and push everything else down." No other section is modified.

## Data flow

Static. The home page (a server component) defines the `blocks` constant and passes it to the client `TerminalSession`. The array is plain serializable data, so crossing the server→client boundary is fine. No fetching, no state beyond the copy button's transient "copied" flag.

## Accessibility

- Traffic-light dots are decorative (`aria-hidden`).
- Panel carries a `role="group"` / region with `ariaLabel` (default e.g. "Example releases CLI session").
- Copy button has an `aria-label` that toggles "Copy to clipboard" / "Copied".
- Real text in a `<pre>` is natively selectable and screen-reader legible (unlike a canvas/image approach).

## Testing & verification

- `npx tsc --noEmit` in `web/` (and root if touched) — types clean.
- `bun run lint` (oxlint) + `bun run format:check`.
- Visual pass via `bun run dev:web`: confirm the panel renders, text selects and copies, the copy-all button works, internal scroll engages past `maxHeight`, and the layout pushes the ticker/table down in both light and dark themes and at mobile width.
- No unit test for static presentational markup — consistent with how `InstallSteps` / `TerminalCompare` are handled in this repo.

## Risks / edge cases

- **Long output + narrow screens:** lines wrap (`whitespace-pre-wrap`) like a terminal rather than clipping; verify wrapped rows (e.g. ISO-timestamp source lines) stay readable.
- **Copy fidelity:** the copy-all button copies plain text (no highlight markup); native selection likewise yields plain text from the `<pre>`.
- **Content drift:** curated output is a snapshot and can go stale relative to live data. Acceptable for a marketing surface; the future asciinema variant (re-recorded) is the longer-term answer to freshness.
