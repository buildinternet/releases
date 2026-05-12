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
  // ── workers/api/src/routes/orgs.ts: nested resource sub-routes that
  // #750 left undocumented. Detail-level GETs + tag/account/ignored-url
  // writes. Annotate alongside the next pass over orgs.ts. ──
  "GET /orgs/:slug/accounts",
  "POST /orgs/:slug/accounts",
  "DELETE /orgs/:slug/accounts/:platform/:handle",
  "GET /orgs/:slug/activity",
  "GET /orgs/:slug/catalog",
  "GET /orgs/:slug/collections",
  "GET /orgs/:slug/heatmap",
  "GET /orgs/:slug/ignored-urls",
  "POST /orgs/:slug/ignored-urls",
  "DELETE /orgs/:slug/ignored-urls/:url",
  "GET /orgs/:slug/recent-releases",
  "GET /orgs/:slug/releases",
  "GET /orgs/:slug/sparklines",
  "GET /orgs/:slug/tags",
  "PUT /orgs/:slug/tags",
  "DELETE /orgs/:slug/tags",
  "POST /tags",

  // ── workers/api/src/routes/sources.ts: sub-routes #752 left
  // undocumented. Bare and org-scoped variants both apply. ──
  "GET /sources/changelog-files/oversized",
  "GET /sources/changes",
  "GET /sources/feeds",
  "GET /sources/fetchable",
  "GET /sources/:slug/activity",
  "GET /sources/:slug/heatmap",
  "GET /sources/:slug/known-releases",
  "GET /sources/:slug/recent-releases",
  "GET /sources/:slug/sessions",
  "GET /sources/:slug/summaries",
  "POST /sources/:slug/changelog/probe",
  "POST /sources/:slug/content-hash",
  "POST /sources/:slug/fetch",
  "POST /sources/:slug/releases",
  "POST /sources/:slug/releases/batch",
  "POST /sources/:slug/summaries",
  "PATCH /sources/:slug/changelog/tokens",
  "PATCH /sources/:slug/metadata",
  "DELETE /sources/:slug",
  "DELETE /sources/:slug/releases",
  "GET /orgs/:orgSlug/sources/:sourceSlug/activity",
  "GET /orgs/:orgSlug/sources/:sourceSlug/heatmap",
  "GET /orgs/:orgSlug/sources/:sourceSlug/known-releases",
  "GET /orgs/:orgSlug/sources/:sourceSlug/recent-releases",
  "POST /orgs/:orgSlug/sources/:sourceSlug/changelog/probe",
  "POST /orgs/:orgSlug/sources/:sourceSlug/content-hash",
  "POST /orgs/:orgSlug/sources/:sourceSlug/releases/batch",
  "PATCH /orgs/:orgSlug/sources/:sourceSlug/changelog/tokens",
  "PATCH /orgs/:orgSlug/sources/:sourceSlug/metadata",
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
