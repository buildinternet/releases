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
  console.error(`Failed to generate OpenAPI spec: HTTP ${res.status}`);
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
  console.error(`OpenAPI coverage gate: ${holes.length} undocumented public-read route(s).`);
  console.error("");
  console.error("Either add describeRoute(...) in the corresponding workers/api/src/routes/");
  console.error("file, or add an explicit ALLOWLIST entry in");
  console.error("scripts/check-openapi-coverage.ts with a rationale comment.");
  console.error("");
  for (const h of holes.toSorted()) console.error(`  - ${h}`);
  if (staleAllowlist.length > 0) {
    console.error("");
    console.error("(Also: ALLOWLIST has stale entries that match no registered route.)");
    for (const s of staleAllowlist.toSorted()) console.error(`  - ${s}`);
  }
  process.exit(1);
}

const documented = registered.length - allowedHit.length;
console.log(
  `OpenAPI coverage gate: OK — ${documented} documented, ${allowedHit.length} allowlisted, ${registered.length} total public-read routes.`,
);
if (staleAllowlist.length > 0) {
  console.warn("");
  console.warn(`Warning: ${staleAllowlist.length} stale ALLOWLIST entries (no matching route).`);
  console.warn("Clean these up in scripts/check-openapi-coverage.ts:");
  for (const s of staleAllowlist.toSorted()) console.warn(`  - ${s}`);
}
