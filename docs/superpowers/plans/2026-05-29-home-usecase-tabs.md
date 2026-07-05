# Home-page use-case tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a row of use-case tabs to the home-page terminal demo (Check product updates / Track a company / Search across vendors), where the tabs are the panel's title bar and each tab carries its own curated transcript with the existing Humans/Agents toggle.

**Architecture:** Extend the presentational `TerminalSession` component with an optional `tabs` prop. When present, an internal `TabBar` replaces the macOS traffic-light chrome, the component holds an `activeTab` index, and only the active tab's transcript renders (single reveal state machine, snap-on-switch). `page.tsx` swaps its inline `DEMO_SESSION` for a `DEMO_TABS` array. Fiddly keyboard-nav index math is extracted to a pure, unit-tested helper; the rest is verified in-browser.

**Tech Stack:** Next.js (App Router) client component, React `useState`/`useEffect`, Tailwind, `bun:test` for the pure helper, the `releases` CLI for capturing real demo data.

**Reference spec:** `docs/superpowers/specs/2026-05-29-home-usecase-tabs-design.md`

---

## File Structure

- **Create** `web/src/components/terminal-tab-nav.ts` — pure `nextTabIndex(current, key, count)` helper (no React import) so it's unit-testable, mirroring the `collection-timeline-rollup.ts` pure-logic pattern.
- **Create** `web/src/components/terminal-tab-nav.test.ts` — `bun:test` coverage for the helper.
- **Modify** `web/src/components/terminal-session.tsx` — add `TerminalTab` type + `tabs?` prop + `activeTab` state + internal `TabBar`; route render/animation/footer/copy through the active tab's blocks.
- **Modify** `web/src/app/page.tsx` — replace `DEMO_SESSION: TerminalBlock[]` with `DEMO_TABS: TerminalTab[]`; pass `tabs={DEMO_TABS}`; update the doc comment.

---

## Task 0: Install deps in the worktree

Linked git worktrees don't inherit `node_modules`; package resolution (and `tsc`/`bun test`/dev server) silently misbehaves without an install.

**Files:** none (environment setup)

- [ ] **Step 1: Install**

Run from the worktree root (`~/Code/releases/.claude/worktrees/home-usecase-tabs`):

```bash
bun install
```

Expected: completes without error; `web/node_modules` (or root `node_modules` with web's deps) populated.

- [ ] **Step 2: Baseline the existing web tests pass**

Run:

```bash
bun test web/
```

Expected: PASS (existing suite green before we change anything).

---

## Task 1: Pure keyboard-nav helper (TDD)

The tablist needs Left/Right (wraparound) + Home/End navigation. The index math is pure and error-prone — extract and unit-test it. No React import here so the test stays light.

**Files:**

- Create: `web/src/components/terminal-tab-nav.ts`
- Test: `web/src/components/terminal-tab-nav.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/components/terminal-tab-nav.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { nextTabIndex } from "./terminal-tab-nav";

describe("nextTabIndex", () => {
  test("ArrowRight advances", () => {
    expect(nextTabIndex(0, "ArrowRight", 3)).toBe(1);
  });
  test("ArrowRight wraps past the end", () => {
    expect(nextTabIndex(2, "ArrowRight", 3)).toBe(0);
  });
  test("ArrowLeft retreats", () => {
    expect(nextTabIndex(1, "ArrowLeft", 3)).toBe(0);
  });
  test("ArrowLeft wraps before the start", () => {
    expect(nextTabIndex(0, "ArrowLeft", 3)).toBe(2);
  });
  test("Home jumps to first", () => {
    expect(nextTabIndex(2, "Home", 3)).toBe(0);
  });
  test("End jumps to last", () => {
    expect(nextTabIndex(0, "End", 3)).toBe(2);
  });
  test("non-nav keys return null", () => {
    expect(nextTabIndex(0, "Enter", 3)).toBeNull();
    expect(nextTabIndex(0, " ", 3)).toBeNull();
  });
  test("guards an empty tablist", () => {
    expect(nextTabIndex(0, "ArrowRight", 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test web/src/components/terminal-tab-nav.test.ts
```

Expected: FAIL — `Cannot find module './terminal-tab-nav'` (or `nextTabIndex is not a function`).

- [ ] **Step 3: Write minimal implementation**

Create `web/src/components/terminal-tab-nav.ts`:

```ts
/**
 * Resolves the next active-tab index for a `keydown` on a tablist, following
 * the WAI-ARIA tabs pattern: Left/Right move with horizontal wraparound,
 * Home/End jump to the ends. Returns `null` for any non-navigation key (and
 * for an empty tablist) so the caller can ignore the event.
 */
export function nextTabIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
bun test web/src/components/terminal-tab-nav.test.ts
```

Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/terminal-tab-nav.ts web/src/components/terminal-tab-nav.test.ts
git commit -m "feat(web): pure tablist keyboard-nav helper"
```

---

## Task 2: Extend TerminalSession with a `tabs` prop + TabBar

Add the optional `tabs` prop, `activeTab` state, and an internal `TabBar` that replaces the traffic-light chrome. Route the transcript renderer, reveal animation, footer, and copy text through the active tab's blocks. Backward compatible: callers passing `blocks` are unchanged.

**Files:**

- Modify: `web/src/components/terminal-session.tsx`

- [ ] **Step 1: Import the helper**

At the top of `web/src/components/terminal-session.tsx`, add to the existing import block (below the `useCopyToClipboard` import line):

```ts
import { nextTabIndex } from "@/components/terminal-tab-nav";
```

- [ ] **Step 2: Export the `TerminalTab` type**

Immediately after the `TerminalBlock` type definition (after its closing `};`), add:

```ts
/** One use-case tab: a label and its own command/output transcript. */
export type TerminalTab = { id: string; label: string; blocks: TerminalBlock[] };
```

- [ ] **Step 3: Add the `tabs` prop to `TerminalSessionProps`**

Inside `type TerminalSessionProps = { ... }`, add after the `blocks` field:

```ts
  /**
   * Optional use-case tabs. When provided, a tab row replaces the traffic-light
   * chrome and the component renders the active tab's transcript; the `blocks`
   * prop is ignored. The Humans/Agents toggle and replay operate on the active
   * tab.
   */
  tabs?: TerminalTab[];
```

- [ ] **Step 4: Accept the prop and derive the active transcript**

In the `TerminalSession({ ... })` destructure, add `tabs,` after `blocks,`. Then, right after the `useCopyToClipboard()` line and before `const scrollerRef`, add the active-tab state:

```ts
const [activeTab, setActiveTab] = useState(0);
```

Then replace the existing line:

```ts
const hasJson = blocks.some((b) => b.json != null);
```

with (this introduces `activeBlocks`, used everywhere below; `tabs[i].blocks` is a stable reference so it's safe in effect deps):

```ts
const hasTabs = tabs != null && tabs.length > 0;
const activeBlocks = hasTabs ? tabs[activeTab].blocks : blocks;
const hasJson = activeBlocks.some((b) => b.json != null);
```

- [ ] **Step 5: Route `fullText` through `activeBlocks`**

Replace `const fullText = blocks` with `const fullText = activeBlocks` (only the leading `blocks` token on that line changes; the `.map(...)` chain is unchanged).

- [ ] **Step 6: Add a tab-switch handler (snap, preserve view)**

Right after the existing `switchView` `useCallback`, add:

```ts
// Switching use-case tabs snaps the new transcript to its final state (no
// re-typing) and preserves the Humans/Agents selection.
const switchTab = useCallback((next: number) => {
  setActiveTab(next);
  setReveal((r) => ({ ...r, done: true }));
}, []);
```

- [ ] **Step 7: Route the reveal animation through `activeBlocks`**

In the reveal-advance `useEffect` (the one starting `if (reveal.done || agentMode) return;`), change `const block = blocks[reveal.block];` to `const block = activeBlocks[reveal.block];`, change both `blocks.length` references in that effect body to `activeBlocks.length`, and change the dependency array `}, [reveal, blocks, agentMode]);` to `}, [reveal, activeBlocks, agentMode]);`.

- [ ] **Step 8: Render the tab bar in place of the chrome**

Replace the entire `showChrome && ( ... )` block (the `<div aria-hidden ...>` with the three traffic-light `<span>`s) with:

```tsx
{
  hasTabs ? (
    <TabBar tabs={tabs} active={activeTab} onSelect={switchTab} />
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
  );
}
```

- [ ] **Step 9: Make the transcript region a tabpanel**

Change the scroller `<div ref={scrollerRef} className="overflow-auto" style={scrollerStyle}>` to add tabpanel semantics when tabbed:

```tsx
      <div
        ref={scrollerRef}
        className="overflow-auto"
        style={scrollerStyle}
        role={hasTabs ? "tabpanel" : undefined}
        id={hasTabs ? `terminal-tabpanel-${tabs[activeTab].id}` : undefined}
        aria-labelledby={hasTabs ? `terminal-tab-${tabs[activeTab].id}` : undefined}
      >
```

Also replace the transcript map source `blocks.map((block, bi) =>` with `activeBlocks.map((block, bi) =>`.

- [ ] **Step 10: Replace the `<section>` aria-label so it names the active tab**

Change the `<section aria-label={ariaLabel}` opening to:

```tsx
    <section
      aria-label={hasTabs ? `${tabs[activeTab].label} — ${ariaLabel}` : ariaLabel}
```

- [ ] **Step 11: Add the `TabBar` sub-component**

After the `TerminalSession` function's closing brace (before `const ID_TOKEN`), add:

```tsx
function TabBar({
  tabs,
  active,
  onSelect,
}: {
  tabs: TerminalTab[];
  active: number;
  onSelect: (i: number) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div
      role="tablist"
      aria-label="Use cases"
      className="flex items-center gap-1 overflow-x-auto border-b border-stone-200/70 px-2 py-1.5 dark:border-stone-800/60"
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
            aria-controls={`terminal-tabpanel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(i)}
            className={`shrink-0 rounded-md px-2.5 py-1 font-mono text-[12px] whitespace-nowrap transition-colors ${
              selected
                ? "bg-white text-stone-900 shadow-sm dark:bg-stone-700 dark:text-stone-100"
                : "text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 12: Type-check**

Run:

```bash
cd web && npx tsc --noEmit && cd ..
```

Expected: PASS (no errors). `useRef` is already imported in the existing import line; confirm it is (it is used by `scrollerRef`).

- [ ] **Step 13: Lint + existing tests still green**

Run from the worktree root:

```bash
bun run lint && bun test web/
```

Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add web/src/components/terminal-session.tsx
git commit -m "feat(web): use-case tabs on TerminalSession"
```

---

## Task 3: Capture real CLI output for the two new tabs

The demo's invariant is that it never invents a format the CLI doesn't print. Capture real human + `--json` output for the product and company tabs. Run these from the **main checkout root** (`~/Code/releases`), where the `releases` CLI env (`RELEASES_API_URL` via `.env`) is configured for prod. This task only reads — it writes scratch files outside the repo.

**Files:** scratch only — `~/.claude/jobs/33c9c864/tmp/cli-capture/*.txt`

- [ ] **Step 1: Confirm the product slug resolves**

Run (from `~/Code/releases`):

```bash
releases get next.js 2>&1 | head -30
```

Expected: a product/org card for Next.js with a "Latest … releases" list. If it errors with a bare-slug rejection or not-found, find the canonical identifier instead:

```bash
releases search "next.js" --type catalog --limit 5
```

and use the resolved form (e.g. `vercel/next.js`, or the `prod_…` id) for the captures below. Record the working invocation.

- [ ] **Step 2: Capture the product tab (human + JSON)**

```bash
mkdir -p ~/.claude/jobs/33c9c864/tmp/cli-capture
releases get next.js      > ~/.claude/jobs/33c9c864/tmp/cli-capture/product.txt 2>&1
releases get next.js --json > ~/.claude/jobs/33c9c864/tmp/cli-capture/product.json 2>&1
```

(Substitute the working invocation from Step 1 if different.)

- [ ] **Step 3: Capture the company tab (human + JSON)**

```bash
releases get vercel      > ~/.claude/jobs/33c9c864/tmp/cli-capture/company.txt 2>&1
releases get vercel --json > ~/.claude/jobs/33c9c864/tmp/cli-capture/company.json 2>&1
```

- [ ] **Step 4: Sanity-check the captures**

Read all four files. Verify:

- Product output shows a single product's releases; company output shows Vercel's activity (ideally spanning more than one source/product so the "company vs product" contrast lands).
- If Vercel's output is empty, errors, or reads as a single-source feed indistinguishable from the product tab, **fall back**: reuse the existing curated `releases get cursor` block (already in `page.tsx` as block 3) for the company tab and note the fallback in the Task 4 doc comment.

No commit (scratch data feeds Task 4).

---

## Task 4: Rewrite page.tsx to use DEMO_TABS

Replace the inline `DEMO_SESSION` with a three-tab `DEMO_TABS` array and pass it to `TerminalSession`. Transcribe the Task 3 captures into tabs 1 & 2, trimmed to the demo's 83-char width the same way block 3 already is (dates → `YYYY-MM-DD`, space-align release rows, cap at 3 releases). Tab 3 reuses the existing search + drill-in blocks verbatim.

**Files:**

- Modify: `web/src/app/page.tsx`

- [ ] **Step 1: Update the import**

Change the existing import:

```ts
import { TerminalSession, type TerminalBlock } from "@/components/terminal-session";
```

to:

```ts
import { TerminalSession, type TerminalTab } from "@/components/terminal-session";
```

- [ ] **Step 2: Replace `DEMO_SESSION` with `DEMO_TABS`**

Replace the entire `const DEMO_SESSION: TerminalBlock[] = [ ... ];` declaration (and its doc comment) with the structure below. Tab 3's two blocks are the **current** block 1 (`search "webhooks"`) and block 2 (`get rel_vpnvl…`) moved verbatim — copy their existing `command`/`output`/`json` strings unchanged. Tabs 1 & 2 are filled from the Task 3 captures (shown here with placeholder-free real-shape examples; replace the values with the actual captured stdout):

```ts
/**
 * Curated `releases` CLI transcripts behind the home-page demo's use-case tabs.
 * Faithful to the live CLI: real commands, values, IDs, and AI summaries. Each
 * tab is a distinct workflow; the Humans view dims the `rel_…` handles, the
 * Agents view appends `--json` and shows the real structured payload.
 *
 *  - "Check product updates": `releases get <product>` — one product's latest
 *    releases. Captured from the live CLI; release rows are space-aligned and
 *    dates shortened to YYYY-MM-DD (the CLI uses tabs that expand past the
 *    83-char demo width).
 *  - "Track a company": `releases get <org>` — an org's activity across its
 *    sources/products, showing the company-vs-product contrast.
 *  - "Search across vendors": cross-vendor `search` then a `get rel_…` drill-in
 *    (the prior single-transcript demo's first two blocks, unchanged).
 *
 * Edit here when refreshing; re-capture tabs 1 & 2 with the `releases` CLI so
 * the format never drifts from real stdout.
 */
const DEMO_TABS: TerminalTab[] = [
  {
    id: "product",
    label: "Check product updates",
    blocks: [
      {
        command: "releases get next.js",
        output: `<<< paste product.txt, trimmed to demo width >>>`,
        json: `<<< paste product.json >>>`,
      },
    ],
  },
  {
    id: "company",
    label: "Track a company",
    blocks: [
      {
        command: "releases get vercel",
        output: `<<< paste company.txt, trimmed to demo width >>>`,
        json: `<<< paste company.json >>>`,
      },
    ],
  },
  {
    id: "search",
    label: "Search across vendors",
    blocks: [
      // === existing block 1 (search "webhooks") — command/output/json verbatim ===
      // === existing block 2 (get rel_vpnvl…) — command/output/json verbatim ===
    ],
  },
];
```

> Execution note: the `<<< … >>>` markers and the `// === … ===` comments are fill-in instructions, not literal content — replace them with the captured/copied strings. Do not leave any marker in the committed file.

- [ ] **Step 3: Update the JSX**

Change the render call:

```tsx
<TerminalSession
  blocks={DEMO_SESSION}
  maxHeight="20rem"
  animate
  ariaLabel="Example releases CLI session"
/>
```

to:

```tsx
<TerminalSession
  tabs={DEMO_TABS}
  maxHeight="20rem"
  animate
  ariaLabel="Example releases CLI session"
/>
```

- [ ] **Step 4: Type-check, lint, build the page**

Run:

```bash
cd web && npx tsc --noEmit && cd ..
bun run lint
cd web && npx next build 2>&1 | tail -20 && cd ..
```

Expected: `tsc` clean, lint clean, `next build` completes (home route compiles). If `next build` needs API env that isn't present in the worktree, it's acceptable to skip the full build and rely on `tsc` + the dev-server check in Task 5 — note which was run.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/page.tsx
git commit -m "feat(web): home demo use-case tabs (product / company / search)"
```

---

## Task 5: In-browser verification

Confirm the rendered behavior matches the spec. Use the `run` skill (or Claude-in-Chrome) — do not claim done without observing it.

**Files:** none (verification)

- [ ] **Step 1: Start the web dev server**

From the worktree root:

```bash
bun run dev:web
```

(Per portless, the worktree branch is reachable at a prefixed host such as `worktree-home-usecase-tabs.releases.localhost`; read the dev script output for the exact URL.)

- [ ] **Step 2: Load the home page and verify, in both light and dark mode:**
  - The three tabs (`Check product updates`, `Track a company`, `Search across vendors`) render as the panel's **title bar** (no traffic-light dots).
  - Default tab is **Check product updates**, and it **types out** on load (animation).
  - Clicking another tab **snaps** to its transcript with no re-typing.
  - Left/Right/Home/End arrow keys move between tabs when a tab is focused; focus follows.
  - The `Humans / Agents` toggle works **per tab**, and the selection **persists** when switching tabs.
  - Copy and replay target the active tab.
  - The tab row scrolls horizontally (no layout break) at a narrow/mobile width.

- [ ] **Step 3: Capture a screenshot or short GIF** of the tabs + a switch, for the PR.

- [ ] **Step 4: Stop the dev server.**

---

## Self-Review (completed during planning)

- **Spec coverage:** Layout (Task 2 step 8) ✓ · `tabs` prop + `TerminalTab` (Task 2) ✓ · three tabs + content + default (Task 4) ✓ · real CLI values + Cursor fallback (Task 3) ✓ · animate-on-mount / snap-on-switch / view persistence (Task 2 steps 6–7) ✓ · a11y tablist/tabpanel/arrow-keys (Tasks 1, 2 steps 9–11) ✓ · active-tab-only render + data-nosnippet wrapper unchanged (Task 2 + page.tsx untouched wrapper) ✓ · testing/verification (Tasks 1, 5) ✓.
- **Placeholder scan:** the only `<<< >>>` / `// === ===` markers are in Task 4 and are explicitly flagged as fill-in instructions with a "remove before commit" note — they depend on Task 3's live capture, which can't be hard-coded in advance.
- **Type consistency:** `TerminalTab` (`{ id; label; blocks }`), `nextTabIndex(current, key, count)`, `activeBlocks`, `hasTabs`, `switchTab`, and the `terminal-tab-{id}` / `terminal-tabpanel-{id}` id pair are used identically across Tasks 1, 2, and 4.
