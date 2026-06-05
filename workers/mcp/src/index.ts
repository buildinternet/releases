import { createMcpHandler } from "agents/mcp";
import { isHtmlRequest, renderLandingPage } from "./landing.js";
import { createServer, type Env } from "./mcp-agent.js";
import { resolveMcpAuth, machineTokenIdForUsage } from "./auth.js";
import { touchLastUsed } from "@releases/core-internal/api-token-store";
import { FLAGS, flag } from "@releases/lib/flags";
import { createDb } from "./db.js";

async function handle(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  noIndex: boolean,
): Promise<Response> {
  const url = new URL(request.url);

  if (noIndex && request.method === "GET" && url.pathname === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  // Resolve the caller's identity (relk_ token → scopes, static key → root,
  // else anonymous read) and enforce the staging access gate in one pass. The
  // gate runs above createMcpHandler so MCP routing is only reached once the
  // caller clears it; per-tool scope enforcement happens inside createServer.
  const auth = await resolveMcpAuth(request, env);
  if (!auth.ok) return auth.response;
  const { identity } = auth;
  // Record token usage (throttled, fire-and-forget) so the admin surface can
  // audit last-used across both the API and MCP workers. relu_ user keys are
  // metered by Better Auth's apikey table, not api_tokens — skip them here.
  const usageTokenId = machineTokenIdForUsage(identity);
  if (usageTokenId) {
    ctx.waitUntil(touchLastUsed(createDb(env.DB), usageTokenId).catch(() => undefined));
  }

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

  const server = await createServer(env, ctx, {
    userAgent: request.headers.get("user-agent"),
    authScopes: identity.scopes,
    authToken: identity.token,
  });
  return createMcpHandler(server)(request, env, ctx);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Resolve the indexing flag once per request; reused for the /robots.txt
    // short-circuit inside handle() and the X-Robots-Tag stamp below.
    const noIndex = await flag(env.FLAGS, env.INDEXING_DISABLED, FLAGS.indexingDisabled);
    const response = await handle(request, env, ctx, noIndex);
    if (!noIndex) return response;
    // Rewrap so the headers bag is mutable — createMcpHandler may return a
    // Response with sealed headers.
    const tagged = new Response(response.body, response);
    tagged.headers.set("X-Robots-Tag", "noindex, nofollow");
    return tagged;
  },
} satisfies ExportedHandler<Env>;
