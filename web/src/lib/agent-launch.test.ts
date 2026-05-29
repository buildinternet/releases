import { describe, expect, test } from "bun:test";
import {
  AGENTS,
  CLAUDE_CODE_MCP_CMD,
  CLI_SETUP_PROMPT,
  CODEX_MCP_CMD,
  MCP_REMOTE_URL,
  claudeCodeCliHref,
  cursorCliHref,
  cursorMcpHref,
  vscodeMcpHref,
} from "./agent-launch";

describe("agent-launch", () => {
  test("cursor deep link encodes the stdio config as base64", () => {
    const prefix = "cursor://anysphere.cursor-deeplink/mcp/install?name=releases&config=";
    expect(cursorMcpHref.startsWith(prefix)).toBe(true);
    const config = JSON.parse(atob(cursorMcpHref.slice(prefix.length)));
    expect(config).toEqual({ command: "npx", args: ["mcp-remote", MCP_REMOTE_URL] });
  });

  test("vscode deep link encodes name + stdio config as url-encoded JSON", () => {
    const prefix = "vscode:mcp/install?";
    expect(vscodeMcpHref.startsWith(prefix)).toBe(true);
    const payload = JSON.parse(decodeURIComponent(vscodeMcpHref.slice(prefix.length)));
    expect(payload).toEqual({
      name: "releases",
      command: "npx",
      args: ["mcp-remote", MCP_REMOTE_URL],
    });
  });

  test("claude code + codex use the documented terminal commands", () => {
    expect(CLAUDE_CODE_MCP_CMD).toBe(
      "claude mcp add --transport http releases https://mcp.releases.sh/mcp",
    );
    expect(CODEX_MCP_CMD).toBe("codex mcp add releases --url https://mcp.releases.sh/mcp");
  });

  test("registry covers exactly the four chosen agents in order", () => {
    expect(AGENTS.map((a) => a.id)).toEqual(["cursor", "vscode", "claude-code", "codex"]);
  });

  test("cursor + vscode add MCP via deep link; claude code + codex via copy", () => {
    const byId = Object.fromEntries(AGENTS.map((a) => [a.id, a]));
    expect(byId.cursor.mcp).toEqual({ kind: "deeplink", href: cursorMcpHref });
    expect(byId.vscode.mcp).toEqual({ kind: "deeplink", href: vscodeMcpHref });
    expect(byId["claude-code"].mcp).toEqual({ kind: "copy", command: CLAUDE_CODE_MCP_CMD });
    expect(byId.codex.mcp).toEqual({ kind: "copy", command: CODEX_MCP_CMD });
  });

  test("CLI target launches where a prompt scheme exists, copies otherwise", () => {
    const byId = Object.fromEntries(AGENTS.map((a) => [a.id, a]));
    // Cursor + Claude Code have documented prompt deeplinks → launch.
    expect(byId.cursor.cli).toEqual({ kind: "deeplink", href: cursorCliHref });
    expect(byId["claude-code"].cli).toEqual({ kind: "deeplink", href: claudeCodeCliHref });
    // VS Code + Codex have no prompt scheme → copy the same setup prompt.
    expect(byId.vscode.cli).toEqual({ kind: "copy", command: CLI_SETUP_PROMPT });
    expect(byId.codex.cli).toEqual({ kind: "copy", command: CLI_SETUP_PROMPT });
  });

  test("prompt deeplinks carry the URL-encoded CLI setup prompt", () => {
    const cursorPrefix = "cursor://anysphere.cursor-deeplink/prompt?text=";
    expect(cursorCliHref.startsWith(cursorPrefix)).toBe(true);
    expect(decodeURIComponent(cursorCliHref.slice(cursorPrefix.length))).toBe(CLI_SETUP_PROMPT);

    const claudePrefix = "claude-cli://open?q=";
    expect(claudeCodeCliHref.startsWith(claudePrefix)).toBe(true);
    expect(decodeURIComponent(claudeCodeCliHref.slice(claudePrefix.length))).toBe(CLI_SETUP_PROMPT);
  });

  test("the CLI setup prompt names the install command, llms.txt, and skill", () => {
    expect(CLI_SETUP_PROMPT).toContain("npm install -g @buildinternet/releases");
    expect(CLI_SETUP_PROMPT).toContain("https://releases.sh/llms.txt");
    expect(CLI_SETUP_PROMPT).toContain("npx skills add buildinternet/releases-cli");
  });
});
