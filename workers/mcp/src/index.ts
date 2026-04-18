import { createMcpHandler } from "agents/mcp";
import { createServer, type Env } from "./mcp-agent.js";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          name: "Released MCP Server",
          description: "Changelog registry — search releases, compare products, and get AI summaries",
          mcp_endpoint: "/mcp",
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const server = createServer(env, ctx);
    return createMcpHandler(server)(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
