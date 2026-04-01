import { logger } from "../lib/logger.js";
import { handleStats } from "./routes/stats.js";
import { handleOrgs, handleOrgDetail } from "./routes/orgs.js";
import { handleSources, handleSourceDetail, handleSourceActivity } from "./routes/sources.js";
import { handleSearch } from "./routes/search.js";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function errorResponse(error: string, message: string, status: number): Response {
  return jsonResponse({ error, message }, status);
}

export function startApiServer(port: number) {
  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      if (req.method !== "GET") {
        return errorResponse("method_not_allowed", "Only GET requests are supported", 405);
      }

      try {
        // GET /api/stats
        if (pathname === "/api/stats") {
          return jsonResponse(handleStats());
        }

        // GET /api/orgs
        if (pathname === "/api/orgs") {
          return jsonResponse(handleOrgs());
        }

        // GET /api/orgs/:slug
        const orgMatch = pathname.match(/^\/api\/orgs\/([^/]+)$/);
        if (orgMatch) {
          const result = handleOrgDetail(orgMatch[1]);
          if (!result) return errorResponse("not_found", "Organization not found", 404);
          return jsonResponse(result);
        }

        // GET /api/sources
        if (pathname === "/api/sources") {
          return jsonResponse(handleSources(url.searchParams));
        }

        // GET /api/sources/:slug/activity
        const sourceActivityMatch = pathname.match(/^\/api\/sources\/([^/]+)\/activity$/);
        if (sourceActivityMatch) {
          const result = handleSourceActivity(sourceActivityMatch[1], url.searchParams);
          if (!result) return errorResponse("not_found", "Source not found", 404);
          return jsonResponse(result);
        }

        // GET /api/sources/:slug
        const sourceMatch = pathname.match(/^\/api\/sources\/([^/]+)$/);
        if (sourceMatch) {
          const page = parseInt(url.searchParams.get("page") ?? "1", 10);
          const pageSize = parseInt(url.searchParams.get("pageSize") ?? "20", 10);
          const result = handleSourceDetail(sourceMatch[1], page, pageSize);
          if (!result) return errorResponse("not_found", "Source not found", 404);
          return jsonResponse(result);
        }

        // GET /api/search
        if (pathname === "/api/search") {
          const q = url.searchParams.get("q") ?? "";
          if (!q) return errorResponse("bad_request", "Missing required query parameter: q", 400);
          const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
          const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
          return jsonResponse(handleSearch(q, limit, offset));
        }

        return errorResponse("not_found", `No route matches ${pathname}`, 404);
      } catch (err) {
        logger.error("API error:", err);
        return errorResponse("internal_error", "An unexpected error occurred", 500);
      }
    },
  });

  logger.info(`API server listening on http://localhost:${server.port}`);
  return server;
}
