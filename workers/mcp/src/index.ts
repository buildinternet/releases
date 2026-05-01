import { createMcpHandler } from "agents/mcp";
import { isHtmlRequest, renderLandingPage } from "./landing.js";
import { createServer, type Env } from "./mcp-agent.js";

/** Custom header carrying the staging shared secret. Mirrors workers/api. */
const STAGING_KEY_HEADER = "X-Releases-Staging-Key";

/**
 * Staging access gate. Accepts the secret via either:
 *   - `X-Releases-Staging-Key: <key>` — preferred for CLI/curl callers.
 *   - `Authorization: Bearer <key>` — enables Anthropic managed-agent vault
 *     credentials (which only expose OAuth or Bearer, not custom headers) to
 *     reach `mcp-staging` without a separate header.
 *
 * The gate runs above `createMcpHandler`, so MCP's own downstream auth (API
 * key checks inside tool handlers) is independent. Requests that pass the
 * gate with the staging key may still 401 at the tool layer if they try to
 * call an authenticated tool — see docs/architecture/mcp.md for the staging
 * auth follow-up.
 */
async function checkStagingKey(request: Request, env: Env): Promise<Response | null> {
  if (!env.STAGING_ACCESS_KEY) return null;
  if (request.method === "OPTIONS") return null;
  const secret = await env.STAGING_ACCESS_KEY.get();
  if (!secret) return null;
  if (request.headers.get(STAGING_KEY_HEADER) === secret) return null;
  const auth = request.headers.get("Authorization") ?? "";
  if (auth.startsWith("Bearer ") && auth.slice(7) === secret) return null;
  return new Response(
    JSON.stringify({ error: "unauthorized", message: "Missing or invalid staging access key" }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const noIndex = env.INDEXING_DISABLED === "true";

  if (noIndex && request.method === "GET" && url.pathname === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  const unauthorized = await checkStagingKey(request, env);
  if (unauthorized) return unauthorized;

  if (url.pathname === "/" && request.method === "GET") {
    if (isHtmlRequest(request)) {
      // Always advertise https for real hosts — Cloudflare terminates TLS at
      // the edge, and a plain-http URL would be wrong to copy/paste. Leave
      // localhost alone so `bun run dev:mcp` still shows a working URL.
      const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
      const scheme = isLocal ? url.protocol.replace(":", "") : "https";
      const mcpUrl = `${scheme}://${url.host}/mcp`;
      return new Response(renderLandingPage(mcpUrl), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=300",
        },
      });
    }
    return Response.json({
      name: "Releases MCP Server",
      description: "Changelog registry — search releases, compare products, and get AI summaries",
      mcp_endpoint: "/mcp",
    });
  }

  const server = createServer(env, ctx, {
    userAgent: request.headers.get("user-agent"),
  });
  return createMcpHandler(server)(request, env, ctx);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const response = await handle(request, env, ctx);
    if (env.INDEXING_DISABLED !== "true") return response;
    // Rewrap so the headers bag is mutable — createMcpHandler may return a
    // Response with sealed headers.
    const tagged = new Response(response.body, response);
    tagged.headers.set("X-Robots-Tag", "noindex, nofollow");
    return tagged;
  },
} satisfies ExportedHandler<Env>;
