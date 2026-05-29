import { OpenInAgentMenu } from "@/components/open-in-agent-menu";

/**
 * One-click MCP install row for the docs pages. Renders the shared
 * "Open in [agent]" registry as an inline button row (Cursor / VS Code deep
 * links; Claude Code / Codex copy their `mcp add` command). Kept as a named
 * wrapper so the existing markdown slots don't need to change.
 */
export function McpInstallButtons() {
  return <OpenInAgentMenu target="mcp" display="buttons" className="my-6" />;
}
