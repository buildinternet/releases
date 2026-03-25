import { Command } from "commander";
import { startMcpServer } from "../../mcp/server.js";

export function registerServeCommand(program: Command) {
  program
    .command("serve")
    .description("Start the MCP server on stdio for AI agent integration")
    .action(async () => {
      await startMcpServer();
    });
}
