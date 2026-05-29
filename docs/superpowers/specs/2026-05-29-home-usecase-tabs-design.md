# 2026-05-29 — Home-page demo: use-case tabs

## Problem

The home-page terminal demo (`web/src/app/page.tsx` → `TerminalSession`) shows a single
curated transcript: a cross-vendor `search`, a release drill-in, and `releases get cursor`,
stacked into one scroll. It reads as a monolithic feed — there's no signal about _what
distinct things the registry is for_. A visitor can't tell that "check one product's
updates," "track a whole company," and "search across vendors" are separate, first-class
workflows.

Browse.sh solves the analogous problem with a top row of **use-case tabs** (`Web skill` ·
`Browser automation` · `Debugging` · `Cloud`), each swapping the command/output below.

## Goal

Add a row of use-case tabs to the home-page demo so it showcases distinct workflows instead
of one packed transcript. The existing `Humans / Agents` toggle stays, living _inside_ each
tab.

## Current state

- `web/src/components/terminal-session.tsx` — presentational, renders one `blocks:
TerminalBlock[]` transcript. Already stateful: tracks `view` (`human`/`agents`) and a
  typewriter `reveal` animation. Owns the panel border, the `●●●` traffic-light chrome
  (`showChrome`), the footer (`Humans/Agents` toggle when any block has `json`, plus a
  replay button when `animate`), and a copy button. A `TerminalCompare` sibling shares its
  surface tokens.
- `web/src/app/page.tsx` — defines `DEMO_SESSION: TerminalBlock[]` (3 blocks, real
  CLI-faithful values/IDs) inline and renders `<TerminalSession blocks={DEMO_SESSION}
maxHeight="20rem" animate ariaLabel="Example releases CLI session" />` inside a
  `data-nosnippet` wrapper. The transcript is **static** — not live-fetched.

## Design

### Chosen layout

Tabs become the panel's **title bar** (they replace the `●●●` traffic-light strip; the
bottom border stays so they read as window chrome). One cohesive panel — not a separate nav
bar above a card. The `Humans / Agents` toggle, replay, and copy controls stay in the footer
exactly as today.

### Component

Extend `TerminalSession` with an optional `tabs` prop rather than introducing a wrapper —
the chosen layout puts the tabs _inside_ the panel chrome that `TerminalSession` already
owns, and the component is already stateful, so an `activeTab` index fits the existing
pattern.

```ts
export type TerminalTab = { id: string; label: string; blocks: TerminalBlock[] };

// New optional prop on TerminalSessionProps:
tabs?: TerminalTab[];
```

- When `tabs` is provided: the header renders a `TabBar` (internal sub-component) in place of
  the `●●●` chrome; the component holds `activeTab` state and renders `tabs[activeTab].blocks`
  through the existing transcript renderer.
- When `tabs` is absent: unchanged — renders `blocks` with the traffic-light chrome. The
  `blocks` and `tabs` props are mutually exclusive in practice; `tabs` wins if both are
  passed.
- `hasJson`, `showFooter`, the copy `fullText`, and the replay affordance are all computed
  against the **active tab's** blocks.
- Boundaries: `TabBar` does presentation + keyboard nav only; `TerminalSession` owns active
  state and transcript rendering; `page.tsx` owns the content. `TerminalCompare` and any
  existing `blocks`-only callers are untouched.

### Tabs & content

Three tabs. Reuse the existing curated blocks where possible; add one new product-level
block.

| #   | Tab label                             | Command(s)                                                                    | Notes                                                                                                        |
| --- | ------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | **Check product updates** _(default)_ | `releases get next.js`                                                        | New. Product card + latest releases.                                                                         |
| 2   | **Track a company**                   | `releases get vercel`                                                         | New-ish. Org card spanning multiple products — the multi-product story makes "company vs product" _visible_. |
| 3   | **Search across vendors**             | `releases search "webhooks" --type releases --limit 3` → `releases get rel_…` | Reuses today's blocks 1 + 2 (search, then drill into the Gemini hit).                                        |

- Each tab keeps 1–2 commands — lean, not packed.
- Every block carries `json` so the `Humans / Agents` toggle works on every tab.
- **Default active tab:** Check product updates (simplest to grasp, the user's first example).
- **Real values:** the new tabs 1 & 2 must be populated with real CLI output (and real
  `--json`) captured at build time via the `releases` CLI — the demo's invariant is that it
  never invents a format the CLI doesn't print (see the `DEMO_SESSION` doc comment). Verify
  `releases get next.js` and `releases get vercel` resolve to the intended product/org; if
  Vercel's aggregated output doesn't read cleanly, fall back to reusing the already-curated
  `releases get cursor` block for the company tab.

### Behavior

- **On mount:** animate (type out) the default tab — same as today (`animate` honors
  `prefers-reduced-motion`).
- **On tab switch:** snap to the new tab's fully-revealed transcript, no re-typing. Mirrors
  the existing `switchView` snap (`done: true`), so exploring tabs is instant. Switching tabs
  resets the reveal to done for the new tab; it does **not** restart the typewriter.
- **View persistence:** the `Humans / Agents` selection persists across tab switches.
- **Replay:** replays the _current_ tab (shown only in `human` view once its reveal is done,
  as today).

### Accessibility

- `TabBar`: `role="tablist"`, each tab `role="tab"` with `aria-selected`; Left/Right (and
  Home/End) arrow-key navigation; roving `tabindex`. The transcript region gets
  `role="tabpanel"` and its `aria-label` names the active use case (e.g. "Check product
  updates — example releases CLI session").
- The `Humans / Agents` group keeps its current `role="group"` semantics.

### SEO / performance

- Stays inside the existing `data-nosnippet` wrapper and remains a static client component.
- Only the **active** tab's transcript is rendered (swapped on switch), so a single reveal
  state machine drives the typewriter — no ambiguity about which of three transcripts is
  animating. Inactive tabs' text is therefore not in the SSR HTML, which is fine: the demo is
  `data-nosnippet` and excluded from snippets regardless.

## Out of scope

- No live data fetching — transcripts stay static/curated, as today.
- No new "inspect/compare a release" tab (folded into the Search tab as the drill-in step).
- No changes to `TerminalCompare` or other `TerminalSession` callers.
- No backend/API/CLI changes.

## Testing & verification

- Component test at whatever level the `web` package already tests components: default tab
  animates; switching tabs swaps the transcript and snaps (no re-type); `Humans/Agents`
  toggle operates on the active tab; copy/replay target the active tab.
- Manual in-browser verification via the `run` skill before completion: title-bar tabs, the
  snap on switch, arrow-key tab nav, and both toggle states render correctly in light and
  dark mode.

## Implementation notes

- Replace `DEMO_SESSION: TerminalBlock[]` in `page.tsx` with `DEMO_TABS: TerminalTab[]` and
  pass `tabs={DEMO_TABS}`. Update the explanatory doc comment to describe the three tabs and
  the build-time CLI capture for tabs 1 & 2.
- Worktree needs its own `bun install` before running the web dev server or tests (linked
  worktrees don't inherit `node_modules`).
