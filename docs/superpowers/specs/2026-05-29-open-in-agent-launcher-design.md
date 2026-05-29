# Open in [agent] launcher — design

**Date:** 2026-05-29
**Status:** Approved design, pending spec review
**Branch:** `worktree-feat-open-in-agent-launcher`

## Summary

Add a browse.sh-style **"Open in ▽"** control next to our install commands. Clicking
an agent (Cursor, Claude Code, Codex, VS Code) sets that agent up to use releases.sh —
either by **adding the MCP server** (when the control is attached to the MCP command) or by
**handing the agent a CLI setup prompt** (when attached to a CLI command). Each agent
either **launches** (a real URI-scheme deeplink that opens the app with the action
pre-filled) or **copies** (clipboard, with explicit "Copied" feedback), depending on which
schemes that agent actually publishes. One reusable component, parameterized by which
command it sits on.

## Background: what browse.sh actually does

browse.sh's dropdown items are real `<a href>` **prompt deeplinks**, not clipboard copies.
Opening the menu and reading the live hrefs shows one anchor per agent, each carrying the
same setup prompt URL-encoded into an app scheme:

- Cursor → `cursor://anysphere.cursor-deeplink/prompt?text=Set%20up%20the%20Browse%20CLI…`
- Codex → `codex://new?prompt=…`
- Conductor → `conductor://prompt=…`
- Claude Code → `claude-cli://open?q=…`

(An earlier pass mis-instrumented this by patching `clipboard.writeText`; the decisive tell
is that hovering an item shows an app-intent URL in the status bar — i.e. it's an anchor.)
The prompt text is identical across agents; only the scheme differs. browse.sh is CLI-only,
so it only has the CLI variant, and it ships a deeplink even for agents whose scheme is
unverified.

We have more surface than browse.sh — a CLI **and** a remote MCP server with native install
affordances — so we do **both** targets, and within each target an agent launches via
deeplink where a documented scheme exists and copies otherwise.

## Goals

- A reusable "Open in [agent]" control matching the screenshot's form factor.
- Every item visibly _does something_: a launch item is an `<a href>` (shows its app URL on
  hover, opens the app on click); a copy item shows an explicit "Copied" label.
- **CLI command** → launch the agent with the setup prompt pre-filled where a prompt scheme
  exists (Cursor, Claude Code), copy the prompt otherwise (VS Code, Codex). The prompt text
  is identical regardless of delivery (browse.sh-faithful).
- **MCP command** → add the server: real deeplink for Cursor/VS Code, copy the `mcp add`
  command for Claude Code/Codex.
- Placement: homepage install block + the two docs pages (`/docs/installation`, `/docs/api/mcp`).
- Consolidate the existing 3 ad-hoc MCP buttons (`mcp-install-buttons.tsx`) into this one
  component, sharing a single deep-link encoder.

## Non-goals (YAGNI)

- Entity-page (org/source/product) placement. (Component is reusable; add later.)
- Search-results placement.
- The catalog-row "scoped prompt" variant (e.g. "show what {org} shipped").
- Per-agent customization of the CLI prompt _text_ (identical for all agents; only the
  delivery mechanism — deeplink vs copy — varies).
- Shipping unverified app schemes. Codex's `codex://` (which browse.sh uses) is unconfirmed,
  so Codex copies rather than launching; flip it to a deeplink later if the scheme is
  verified. VS Code has no prompt/chat scheme at all (only file/settings/MCP-install).
- A global toast system (copy feedback is inline).
- Adding/keeping a VS Code Insiders entry (dropped; trivially re-addable via the registry).

## Design

### Reusable component

`web/src/components/open-in-agent-menu.tsx` (`"use client"`):

```ts
type Target = "cli" | "mcp";
type Display = "menu" | "buttons";

function OpenInAgentMenu(props: {
  target: Target;
  display?: Display;
  className?: string;
}): JSX.Element;
```

- `target` selects which action each agent performs (CLI prompt vs MCP add).
- `display`:
  - `"menu"` (default) — a collapsed `[<remembered-agent icon> Open in ▽]` trigger that
    opens a dropdown of the four agents. Used on the homepage install block and the
    `install-tabs.tsx` docs installer.
  - `"buttons"` — an inline row of four labeled agent buttons (no collapse). Used on the
    docs pages where `mcp-install-buttons.tsx` is today (discoverability favored on docs).

The dropdown is hand-rolled, matching the existing `org-admin-menu.tsx` pattern
(`useState` open + `useRef` container + `pointerdown`/`Escape` close). No new UI library —
the repo is Tailwind-only with no Radix/headless-ui.

### Shared pure module

`web/src/lib/agent-launch.ts` — pure, no JSX, unit-testable. Holds the single source of
truth for every payload, lifted out of `mcp-install-buttons.tsx`:

- `MCP_REMOTE_URL = "https://mcp.releases.sh/mcp"` and the `stdioConfig`
  (`{ command: "npx", args: ["mcp-remote", MCP_REMOTE_URL] }`).
- `cursorMcpHref()` → `cursor://anysphere.cursor-deeplink/mcp/install?name=releases&config=<base64(stdioConfig)>`
- `vscodeMcpHref()` → `vscode:mcp/install?<urlencoded({ name:"releases", ...stdioConfig })>`
- `CLAUDE_CODE_MCP_CMD = "claude mcp add --transport http releases https://mcp.releases.sh/mcp"`
- `CODEX_MCP_CMD = "codex mcp add releases --url https://mcp.releases.sh/mcp"`
- `CLI_SETUP_PROMPT` (identical for all agents):

  > Set up the releases.sh CLI so you can look up product changelogs and release notes on
  > demand. Run: `npm install -g @buildinternet/releases`. Then read
  > `https://releases.sh/llms.txt` and follow it to set up the skill
  > (`npx skills add buildinternet/releases-cli`).

  (`https://releases.sh/llms.txt` is served via the Next.js rewrite to `/api/llms`.)

### Agent registry

A typed array in `agent-launch.ts`. Each agent declares how it handles each target:

```ts
type AgentAction =
  | { kind: "deeplink"; href: string } // render <a>, opens the app
  | { kind: "copy"; command: string }; // render <button>, copies to clipboard

type Agent = {
  id: "cursor" | "claude-code" | "codex" | "vscode";
  label: string; // "Cursor", "Claude Code", "Codex", "VS Code"
  Icon: () => JSX.Element; // monochrome inline SVG, currentColor
  mcp: AgentAction;
  cli: AgentAction; // always { kind: "copy", command: CLI_SETUP_PROMPT }
};
```

| Agent       | `mcp` action                   | `cli` action                |
| ----------- | ------------------------------ | --------------------------- |
| Cursor      | `deeplink` → `cursorMcpHref()` | `copy` → `CLI_SETUP_PROMPT` |
| VS Code     | `deeplink` → `vscodeMcpHref()` | `copy` → `CLI_SETUP_PROMPT` |
| Claude Code | `copy` → `CLAUDE_CODE_MCP_CMD` | `copy` → `CLI_SETUP_PROMPT` |
| Codex       | `copy` → `CODEX_MCP_CMD`       | `copy` → `CLI_SETUP_PROMPT` |

The component reads `agent[props.target]` to decide the row's element + behavior:

- `kind: "deeplink"` → render an `<a href>` (clicking opens the app, closes the menu).
- `kind: "copy"` → render a `<button>` (clicking copies via `useCopyToClipboard`, shows an
  inline "Copied ✓" on that row for ~2s, keeps the menu open).

### Placement matrix

| Surface                            | File                                      | Control                                                                 | target                                            |
| ---------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| Homepage hero (mobile)             | `install-steps.tsx` `InstallStepsInline`  | `display="menu"`, sibling of the CodeBlock                              | follows active tab: `mcp` tab → `mcp`, else `cli` |
| Homepage sidebar (desktop)         | `install-steps.tsx` `InstallStepsSidebar` | `display="menu"` in the CLI section (`cli`) and the MCP section (`mcp`) | per-section                                       |
| Docs installer                     | `install-tabs.tsx`                        | `display="menu"`, sibling of the copy button                            | `mcp` tab → `mcp`, else `cli`                     |
| Docs `/docs/installation` MCP slot | `mcp-install-buttons.tsx`                 | `display="buttons"`                                                     | `mcp`                                             |
| Docs `/docs/api/mcp` MCP slot      | `mcp-install-buttons.tsx`                 | `display="buttons"`                                                     | `mcp`                                             |

`mcp-install-buttons.tsx` is rewritten to render `<OpenInAgentMenu target="mcp" display="buttons" />`
(it keeps its `McpInstallButtons` export name + `not-prose my-6` wrapper so the two doc-page
call sites are unchanged). This removes the duplicated deep-link encoders from that file.

### UX / polish

- **Trigger (`menu` mode):** `[<remembered-agent icon> Open in ▾]`. `aria-label="Open in agent"`.
  Dropdown header "OPEN IN…" then four rows, each with a monochrome SVG icon + label; the
  remembered agent row shows a `✓`.
- **Remembered agent:** persisted in `localStorage` under `releases.openInAgent`; defaults to
  Cursor when unset. Cosmetic — only affects which icon the trigger shows and which row is
  checked. Read lazily on the client (guard `typeof window`), never during SSR.
- **Copy feedback:** inline via the existing `useCopyToClipboard` hook + `CopyIcon`'s
  checked state. No new toast infra. Copy rows get a small helper line/tooltip
  ("Copied — paste in your terminal") for the MCP copy-commands.
- **Icons:** reuse the existing Cursor + VS Code inline SVGs (currently in
  `mcp-install-buttons.tsx`, moving to `agent-launch.ts`); add simple monochrome Claude Code
  and Codex marks in `currentColor` to match the stone palette. **No emojis** (per project rule).
- **Button-nesting constraint:** the existing CodeBlock / InstallTabs copy targets are
  themselves `<button>`s (whole-box copy). The "Open in" control must be a **sibling to the
  right**, never nested inside, to keep valid HTML — which also matches the screenshot
  (command box + separate dropdown control). Each touched layout wraps `[CodeBlock][menu]`
  in a `flex items-center gap-2` row.
- **a11y:** `aria-haspopup="menu"`, `aria-expanded`, `role="menu"`/`role="menuitem"`,
  Escape + click-outside close, keyboard focusable rows.

## Files

**Create**

- `web/src/lib/agent-launch.ts` — pure registry + payload builders.
- `web/src/lib/agent-launch.test.ts` — node `.test.ts` (the repo has no RTL); asserts the
  Cursor/VS Code hrefs decode to the expected stdio config, the Claude Code/Codex commands,
  and that the CLI prompt is identical across agents.
- `web/src/components/open-in-agent-menu.tsx` — the component (`menu` + `buttons` displays).

**Modify**

- `web/src/components/mcp-install-buttons.tsx` — re-implement `McpInstallButtons` as a thin
  wrapper over `<OpenInAgentMenu target="mcp" display="buttons" />`; delete the local
  encoders (now in `agent-launch.ts`).
- `web/src/components/install-steps.tsx` — add the menu to `InstallStepsInline` (target by
  active tab) and `InstallStepsSidebar` (CLI + MCP sections).
- `web/src/components/install-tabs.tsx` — add the menu beside the copy button, target by
  active tab.

No API, worker, DB, or `packages/` changes. Web-frontend-only.

## Testing

- `bun test web/src/lib/agent-launch.test.ts` — pure builders (hrefs, commands, prompt
  invariance). This is the meaningful automated coverage given no component-render harness.
- `cd web && npx tsc --noEmit` — type-check.
- `bun run lint` / `bun run format:check`.
- Manual: `bun run dev:web`, verify on `/` (hero install block), `/docs/installation`,
  `/docs/api/mcp` — dropdown opens/closes, Cursor/VS Code rows are real deep links, Claude
  Code/Codex rows copy the right command with inline confirmation, CLI prompt copies, dark
  mode + keyboard/Escape work, remembered agent persists across reloads.

## Risks / edge cases

- **Deep-link availability:** `cursor://` / `vscode:` only resolve if the app is installed;
  the OS shows its own "open app?" prompt (expected, same as today's buttons). No in-page
  dialog is triggered.
- **`localStorage` access:** guarded for SSR / privacy-mode (read in an effect or lazily on
  click; fall back to Cursor).
- **Clipboard API:** `useCopyToClipboard` already uses `navigator.clipboard.writeText`;
  unchanged behavior, same browser support as the existing copy buttons.
- **Layout width:** on the narrow homepage hero, the `[command][Open in ▽]` row must not
  overflow; the command box keeps `min-w-0` / `truncate` and the menu trigger is `shrink-0`.

## Open questions

None blocking. Possible follow-ups (out of scope): entity-page placement, a scoped
"use releases for {entity}" prompt variant, and re-adding VS Code Insiders.
