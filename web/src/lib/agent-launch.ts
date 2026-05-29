/**
 * Single source of truth for the "Open in [agent]" launcher payloads.
 *
 * Imported by a client component, so this module must stay isomorphic — no
 * Node-only APIs (e.g. `Buffer`). Base64 uses `btoa`, which exists in browsers,
 * Bun, and Node 16+; the stdio config is pure ASCII so `btoa` is safe here.
 */

export const MCP_REMOTE_URL = "https://mcp.releases.sh/mcp";

/** stdio bridge config shared by the Cursor + VS Code one-click installers. */
export const stdioConfig = {
  command: "npx",
  args: ["mcp-remote", MCP_REMOTE_URL],
} as const;

/** Cursor MCP deep link — opens Cursor and prompts to add the server. */
export const cursorMcpHref = `cursor://anysphere.cursor-deeplink/mcp/install?name=releases&config=${btoa(
  JSON.stringify(stdioConfig),
)}`;

/** VS Code MCP deep link. */
export const vscodeMcpHref = `vscode:mcp/install?${encodeURIComponent(
  JSON.stringify({ name: "releases", ...stdioConfig }),
)}`;

/** Terminal commands for agents that add MCP via CLI rather than a URI scheme. */
export const CLAUDE_CODE_MCP_CMD = `claude mcp add --transport http releases ${MCP_REMOTE_URL}`;
export const CODEX_MCP_CMD = `codex mcp add releases --url ${MCP_REMOTE_URL}`;

/**
 * The setup instruction handed to an agent for the CLI target — as a prompt
 * deeplink where the agent supports one, or copied to the clipboard otherwise.
 * Points at the public `llms.txt` (served via the Next.js rewrite to
 * `/api/llms`) and the agent skill.
 */
export const CLI_SETUP_PROMPT =
  "Set up the releases.sh CLI so you can look up product changelogs and release notes on demand. " +
  "Run: npm install -g @buildinternet/releases. " +
  "Then read https://releases.sh/llms.txt and follow it to set up the skill " +
  "(npx skills add buildinternet/releases-cli).";

const encodedCliPrompt = encodeURIComponent(CLI_SETUP_PROMPT);

/**
 * Prompt deeplinks — open the agent with `CLI_SETUP_PROMPT` pre-filled (never
 * auto-sent). Only Cursor and Claude Code publish a documented prompt scheme;
 * VS Code and Codex fall back to copy.
 *   Cursor:      https://cursor.com/docs/integrations/deeplinks
 *   Claude Code: https://code.claude.com/docs/en/deep-links (v2.1.91+)
 */
export const cursorCliHref = `cursor://anysphere.cursor-deeplink/prompt?text=${encodedCliPrompt}`;
export const claudeCodeCliHref = `claude-cli://open?q=${encodedCliPrompt}`;

export type AgentId = "cursor" | "vscode" | "claude-code" | "codex";

export type AgentTarget = "cli" | "mcp";

/** Map an install-tab / section id to a launcher target: MCP for the MCP tab, CLI otherwise. */
export function resolveTarget(id: string): AgentTarget {
  return id === "mcp" ? "mcp" : "cli";
}

/** How a given agent handles a given target. */
export type AgentAction =
  | { kind: "deeplink"; href: string } // render an <a> that opens the app
  | { kind: "copy"; command: string }; // render a <button> that copies to the clipboard

export type Agent = {
  id: AgentId;
  label: string;
  mcp: AgentAction;
  cli: AgentAction;
};

/** CLI fallback for agents with no prompt scheme — copy the setup prompt. */
const cliCopy: AgentAction = { kind: "copy", command: CLI_SETUP_PROMPT };

// Per agent, each target either launches (deeplink) or copies, depending on
// which schemes that agent actually publishes:
//   - cli target:  Cursor + Claude Code launch via prompt deeplink; the rest copy.
//   - mcp target:  Cursor + VS Code launch via MCP-install deeplink; the rest copy.
export const AGENTS: readonly Agent[] = [
  {
    id: "cursor",
    label: "Cursor",
    mcp: { kind: "deeplink", href: cursorMcpHref },
    cli: { kind: "deeplink", href: cursorCliHref },
  },
  {
    id: "vscode",
    label: "VS Code",
    mcp: { kind: "deeplink", href: vscodeMcpHref },
    cli: cliCopy,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    mcp: { kind: "copy", command: CLAUDE_CODE_MCP_CMD },
    cli: { kind: "deeplink", href: claudeCodeCliHref },
  },
  {
    id: "codex",
    label: "Codex",
    mcp: { kind: "copy", command: CODEX_MCP_CMD },
    cli: cliCopy,
  },
];

/** Fallback when nothing is remembered in localStorage. */
export const DEFAULT_AGENT_ID: AgentId = "cursor";
