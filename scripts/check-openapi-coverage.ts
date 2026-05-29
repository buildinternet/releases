/**
 * CI gate: every HTTP method registered under a `publicReadRoutes` prefix must
 * appear in `/v1/openapi.json`. Catches public-read routes that ship without
 * `describeRoute(...)` annotations.
 *
 * Run: `bun scripts/check-openapi-coverage.ts` (exit 0 = OK, 1 = holes,
 * 2 = bug — spec couldn't be generated).
 *
 * To opt a route out of coverage during the Phase 1 long-tail port, add an
 * explicit entry to ALLOWLIST below with a comment pointing at the route
 * file. The expectation is that ALLOWLIST shrinks as files get
 * `describeRoute(...)` annotations — stale entries log a warning so they
 * don't accumulate after a route is renamed or removed.
 */
import { Hono } from "hono";
import { logger } from "@buildinternet/releases-lib/logger";
import { publicReadRoutes } from "../workers/api/src/route-namespaces.js";
import { mountV1Routes } from "../workers/api/src/v1-routes.js";
import type { Env } from "../workers/api/src/index.js";

/**
 * `METHOD /hono-style/path` tuples that are knowingly undocumented today.
 * Paths are Hono-style (`:slug`, not OpenAPI `{slug}`) — they match what
 * `v1.routes[].path` returns.
 */
const ALLOWLIST = new Set<string>([
  // These routes are annotated with `hide: hideInProduction` — they exist in
  // the spec on staging/local but are intentionally suppressed on production.
  // The coverage script always generates the spec with ENVIRONMENT=production,
  // so they appear as holes here even though they have describeRoute(). See
  // workers/api/src/openapi.ts for the `hideInProduction` helper.
  "GET /orgs/:slug/activity",
  "GET /orgs/:slug/heatmap",
  "GET /orgs/:slug/sparklines",
  "GET /orgs/:slug/recent-releases",
  "GET /sitemap",
  "GET /sources/fetchable",
  "GET /sources/feeds",
  "GET /sources/changes",
  "GET /sources/:slug/recent-releases",
  "GET /sources/:slug/known-releases",
  "GET /sources/:slug/sessions",
  "GET /sources/:slug/activity",
  "GET /sources/:slug/heatmap",
  "GET /sources/:slug/changelog",
  "GET /sources/changelog-files/oversized",
  // Org-scoped aliases of the above source routes (same describeRoute, same hide):
  "GET /orgs/:orgSlug/sources/:sourceSlug/recent-releases",
  "GET /orgs/:orgSlug/sources/:sourceSlug/known-releases",
  "GET /orgs/:orgSlug/sources/:sourceSlug/activity",
  "GET /orgs/:orgSlug/sources/:sourceSlug/heatmap",
  "GET /orgs/:orgSlug/sources/:sourceSlug/changelog",
  // Product activity/heatmap (same hide: hideInProduction pattern as org/source counterparts):
  "GET /products/:slug/activity",
  "GET /products/:slug/heatmap",
  "GET /orgs/:orgSlug/products/:productSlug/activity",
  "GET /orgs/:orgSlug/products/:productSlug/heatmap",
  // Admin/internal GET routes hidden from production spec (Phase 2 extension):
  "GET /orgs/:slug/catalog", // web-frontend aggregation payload, not shaped for general API consumers
  "GET /orgs/:slug/ignored-urls", // operator-facing ignore-list management
  "GET /releases", // internal media-backfill CLI helper (?hasMedia=true only)
  "GET /orgs/:slug/playbook", // editorial-internal; admin Bearer required even for GET
  "GET /sources/:slug/summaries", // AI-generated content storage; agent-pipeline internal
  "GET /orgs/:slug/overview/inputs", // AI-pipeline input; admin-only orchestration endpoint
  "GET /releases/stream", // experimental WebSocket; not a stable REST surface
  // Write mutations hidden from production spec (same hideInProduction pattern).
  // These are registered under publicReadRoutes prefixes (auth is handled by
  // publicReadAuthMiddleware's SAFE_METHODS check) so the gate sees them as
  // registered routes even though they require Bearer auth at runtime.
  "POST /orgs",
  "PATCH /orgs/:slug",
  "DELETE /orgs/:slug",
  "DELETE /orgs/:slug/accounts/:platform/:handle",
  "POST /orgs/:slug/accounts",
  "PUT /orgs/:slug/tags",
  "DELETE /orgs/:slug/tags",
  "POST /tags",
  "POST /orgs/:slug/ignored-urls",
  "DELETE /orgs/:slug/ignored-urls/:url",
  "POST /orgs/:slug/overview",
  "POST /sources",
  "POST /sources/appstore",
  // Write (Bearer required); annotated with describeRoute but hidden in prod
  // (hideInProduction), same as POST /sources/appstore above. Materializes a
  // video source from a YouTube channel/playlist URL.
  "POST /sources/video",
  "PATCH /sources/:slug",
  "PATCH /orgs/:orgSlug/sources/:sourceSlug",
  "DELETE /sources/:slug",
  "POST /sources/:slug/fetch",
  // Admin-only Firecrawl monitor sync (Bearer required via the publicReadRoutes
  // `sources` prefix); operator/agent-internal, not a stable public surface.
  "POST /sources/:slug/firecrawl/sync",
  "POST /sources/:slug/releases/batch",
  "POST /orgs/:orgSlug/sources/:sourceSlug/releases/batch",
  "DELETE /sources/:slug/releases",
  "POST /sources/:slug/content-hash",
  "POST /orgs/:orgSlug/sources/:sourceSlug/content-hash",
  "PATCH /sources/:slug/metadata",
  "PATCH /orgs/:orgSlug/sources/:sourceSlug/metadata",
  "PATCH /sources/:slug/changelog/tokens",
  "PATCH /orgs/:orgSlug/sources/:sourceSlug/changelog/tokens",
  "POST /sources/:slug/changelog/probe",
  "POST /orgs/:orgSlug/sources/:sourceSlug/changelog/probe",
  // Experimental coordinate-based changelog fetch — hide: hideInProduction,
  // so suppressed in the prod-generated spec this coverage script uses.
  "POST /changelog/fetch",
  // Experimental coordinate-based changelog parse — hide: hideInProduction,
  // so suppressed in the prod-generated spec this coverage script uses.
  "POST /changelog/parse",
  "POST /sources/:slug/releases",
  "POST /sources/:slug/summaries",
  "PATCH /orgs/:slug/playbook/notes",
  "POST /releases/:id/coverage",
  "DELETE /releases/:id/coverage",
  "DELETE /releases/:id",
  "PATCH /releases/:id",
  "POST /releases/:id/suppress",
  "POST /releases/:id/unsuppress",
  "POST /products",
  "POST /products/adopt",
  "PATCH /products/:slug",
  "PATCH /orgs/:orgSlug/products/:productSlug",
  "DELETE /products/:identifier",
  "PUT /products/:identifier/tags",
  "DELETE /products/:identifier/tags",
  "PATCH /categories/:slug",
  "POST /collections",
  "PATCH /collections/:slug",
  "DELETE /collections/:slug",
  "PUT /collections/:slug/members",
  "POST /collections/:slug/members",
  "DELETE /collections/:slug/members/:org",
  "DELETE /collections/:slug/members/products/:product",
]);

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const PUBLIC_READ_PREFIXES = publicReadRoutes.map((r) => `/${r}`);

function honoToOpenapi(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function isPublicReadPath(path: string): boolean {
  return PUBLIC_READ_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

const v1 = new Hono<Env>();
mountV1Routes(v1);

const app = new Hono();
app.route("/v1", v1);
// `mountOpenApi` reads `c.env.ENVIRONMENT` to gate the staging server
// entry; pass an explicit production binding so the script always
// validates against the public-facing spec.
const res = await app.request("/v1/openapi.json", {}, { ENVIRONMENT: "production" });
if (!res.ok) {
  logger.error(`Failed to generate OpenAPI spec: HTTP ${res.status}`);
  process.exit(2);
}
const spec = (await res.json()) as {
  paths?: Record<string, Record<string, unknown>>;
};
const specPaths = spec.paths ?? {};

type Tuple = { method: string; honoPath: string };
// Dedupe — `app.get(path, middleware, handler)` registers an entry per
// variadic, so `v1.routes` contains repeated (method, path) tuples for
// routes that wrap their handler with middleware (e.g. `authMiddleware`).
const registeredKeys = new Set<string>();
const registered: Tuple[] = [];
for (const r of v1.routes) {
  if (!HTTP_METHODS.has(r.method)) continue;
  if (!isPublicReadPath(r.path)) continue;
  const key = `${r.method} ${r.path}`;
  if (registeredKeys.has(key)) continue;
  registeredKeys.add(key);
  registered.push({ method: r.method, honoPath: r.path });
}

const holes: string[] = [];
const allowedHit: string[] = [];
for (const { method, honoPath } of registered) {
  const tuple = `${method} ${honoPath}`;
  const documented = specPaths[honoToOpenapi(honoPath)]?.[method.toLowerCase()];
  if (documented) continue;
  if (ALLOWLIST.has(tuple)) {
    allowedHit.push(tuple);
    continue;
  }
  holes.push(tuple);
}

// Stale allowlist entries — warn but don't fail. Keeps the list from
// accumulating dead entries after a route gets annotated or removed.
const staleAllowlist = [...ALLOWLIST].filter((entry) => !registeredKeys.has(entry));

if (holes.length > 0) {
  logger.error(`OpenAPI coverage gate: ${holes.length} undocumented public-read route(s).`);
  logger.error("");
  logger.error("Either add describeRoute(...) in the corresponding workers/api/src/routes/");
  logger.error("file, or add an explicit ALLOWLIST entry in");
  logger.error("scripts/check-openapi-coverage.ts with a rationale comment.");
  logger.error("");
  for (const h of holes.toSorted()) logger.error(`  - ${h}`);
  if (staleAllowlist.length > 0) {
    logger.error("");
    logger.error("(Also: ALLOWLIST has stale entries that match no registered route.)");
    for (const s of staleAllowlist.toSorted()) logger.error(`  - ${s}`);
  }
  process.exit(1);
}

const documented = registered.length - allowedHit.length;
logger.info(
  `OpenAPI coverage gate: OK — ${documented} documented, ${allowedHit.length} allowlisted, ${registered.length} total public-read routes.`,
);
if (staleAllowlist.length > 0) {
  logger.warn("");
  logger.warn(`Warning: ${staleAllowlist.length} stale ALLOWLIST entries (no matching route).`);
  logger.warn("Clean these up in scripts/check-openapi-coverage.ts:");
  for (const s of staleAllowlist.toSorted()) logger.warn(`  - ${s}`);
}
