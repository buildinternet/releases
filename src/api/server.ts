import { logger } from "@releases/lib/logger";
import { handleStats } from "./routes/stats.js";
import { handleOrgs, handleOrgDetail, handleSitemap } from "./routes/orgs.js";
import { handleSources, handleSourceDetail, handleSourceActivity, handleSourceChangelog, CHANGELOG_PATH_NOT_FOUND } from "./routes/sources.js";
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
        // GET /v1/stats
        if (pathname === "/v1/stats") {
          return jsonResponse(handleStats());
        }

        // GET /v1/orgs
        if (pathname === "/v1/orgs") {
          return jsonResponse(handleOrgs());
        }

        // GET /v1/sitemap
        if (pathname === "/v1/sitemap") {
          return jsonResponse(handleSitemap());
        }

        // GET /v1/orgs/:slug
        const orgMatch = pathname.match(/^\/v1\/orgs\/([^/]+)$/);
        if (orgMatch) {
          const result = handleOrgDetail(orgMatch[1]);
          if (!result) return errorResponse("not_found", "Organization not found", 404);
          return jsonResponse(result);
        }

        // GET /v1/sources
        if (pathname === "/v1/sources") {
          return jsonResponse(handleSources(url.searchParams));
        }

        // GET /v1/sources/:slug/activity
        const sourceActivityMatch = pathname.match(/^\/v1\/sources\/([^/]+)\/activity$/);
        if (sourceActivityMatch) {
          const result = handleSourceActivity(sourceActivityMatch[1], url.searchParams);
          if (!result) return errorResponse("not_found", "Source not found", 404);
          return jsonResponse(result);
        }

        // GET /v1/sources/:slug/changelog
        const sourceChangelogMatch = pathname.match(/^\/v1\/sources\/([^/]+)\/changelog$/);
        if (sourceChangelogMatch) {
          const result = handleSourceChangelog(sourceChangelogMatch[1], url.searchParams);
          if (result === CHANGELOG_PATH_NOT_FOUND) {
            return errorResponse("not_found", `Changelog file not found for path: ${url.searchParams.get("path")}`, 404);
          }
          if (!result) return errorResponse("not_found", "Changelog file not found", 404);
          return jsonResponse(result);
        }

        // GET /v1/sources/:slug
        const sourceMatch = pathname.match(/^\/v1\/sources\/([^/]+)$/);
        if (sourceMatch) {
          const page = parseInt(url.searchParams.get("page") ?? "1", 10);
          const pageSize = parseInt(url.searchParams.get("pageSize") ?? "20", 10);
          const result = handleSourceDetail(sourceMatch[1], page, pageSize);
          if (!result) return errorResponse("not_found", "Source not found", 404);
          return jsonResponse(result);
        }

        // GET /v1/search
        if (pathname === "/v1/search") {
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
