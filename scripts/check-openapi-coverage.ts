/**
 * CI gate for the public API surface (`apps/api/src/api-surface.ts`):
 *
 *   1. Every registered `/v1` route is classified as public or internal —
 *      a new route fails until someone decides which it is.
 *   2. Every public operation appears in the production `/v1/openapi.json`
 *      with a tag, a JSON 2xx response schema (204 excepted), and, for
 *      POST/PUT/PATCH, a JSON request body (unless listed in NO_BODY).
 *   3. Every entry in `api-surface.ts` matches a registered route.
 *
 * That production contains only public operations is guaranteed by
 * `applyApiSurface` and covered by `apps/api/test/api-surface.test.ts`.
 *
 * Run: `bun scripts/check-openapi-coverage.ts` (exit 0 = OK, 1 = violations,
 * 2 = bug — spec couldn't be generated).
 */
import { Hono } from "hono";
import { logger } from "@buildinternet/releases-lib/logger";
import { mountV1Routes } from "../apps/api/src/v1-routes.js";
import {
  PUBLIC_OPERATIONS,
  INTERNAL_OPERATIONS,
  routeVisibility,
  specOperations,
} from "../apps/api/src/api-surface.js";
import type { Env } from "../apps/api/src/index.js";

/** Public writes that take no request body (action endpoints). */
const NO_BODY = new Set<string>([
  "POST /me/webhooks/:id/rotate-secret",
  "POST /me/webhooks/:id/test",
  "POST /workspaces/:workspaceId/webhooks/:id/rotate-secret",
  "POST /workspaces/:workspaceId/webhooks/:id/test",
]);

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

const v1 = new Hono<Env>();
mountV1Routes(v1);

const app = new Hono();
app.route("/v1", v1);
// `mountOpenApi` reads `c.env.ENVIRONMENT`; production is the public spec.
const res = await app.request("/v1/openapi.json", {}, { ENVIRONMENT: "production" });
if (!res.ok) {
  logger.error(`Failed to generate OpenAPI spec: HTTP ${res.status}`);
  process.exit(2);
}
const spec = (await res.json()) as { paths?: unknown };
const specOps = new Map(specOperations(spec.paths).map(({ key, op }) => [key, op]));

// `app.get(path, mw, handler)` registers one entry per handler, so dedupe.
const registered = new Set<string>();
for (const r of v1.routes) {
  if (HTTP_METHODS.has(r.method)) registered.add(`${r.method} ${r.path}`);
}

const unclassified: string[] = [];
const missing: string[] = [];
const untagged: string[] = [];
const noResponse: string[] = [];
const noBody: string[] = [];
const stale: string[] = [];

for (const key of registered) {
  const [method, path] = key.split(" ");
  if (!routeVisibility(method, path)) unclassified.push(key);
}

for (const key of Object.keys(PUBLIC_OPERATIONS)) {
  if (!registered.has(key)) {
    stale.push(key);
    continue;
  }
  const op = specOps.get(key);
  if (!op) {
    missing.push(key);
    continue;
  }
  if (!op.tags?.length) untagged.push(key);
  const hasResponse = Object.entries(op.responses ?? {}).some(
    ([code, r]) => code === "204" || (code.startsWith("2") && r.content?.["application/json"]),
  );
  if (!hasResponse) noResponse.push(key);
  const [method] = key.split(" ");
  if (
    BODY_METHODS.has(method) &&
    !NO_BODY.has(key) &&
    !op.requestBody?.content?.["application/json"]
  )
    noBody.push(key);
}

for (const key of INTERNAL_OPERATIONS) if (!registered.has(key)) stale.push(key);
for (const key of NO_BODY) if (!(key in PUBLIC_OPERATIONS)) stale.push(`${key} (NO_BODY)`);

const failures = (
  [
    [
      "Unclassified routes — add to PUBLIC_OPERATIONS or INTERNAL_OPERATIONS in apps/api/src/api-surface.ts",
      unclassified,
    ],
    ["Public operations missing from the production spec (add describeRoute)", missing],
    ["Public operations without a tag", untagged],
    ["Public operations without a JSON 2xx response schema", noResponse],
    [
      "Public writes without a JSON request body (validateJson / documentedJsonBody, or NO_BODY)",
      noBody,
    ],
    ["Stale api-surface entries (no matching route)", stale],
  ] as const
).filter(([, list]) => list.length > 0);
if (failures.length > 0) {
  logger.error(
    "Public API surface gate failed. See docs/architecture/routing.md → Public API surface.",
  );
  for (const [title, list] of failures) {
    logger.error("");
    logger.error(`${title}:`);
    for (const item of list.toSorted()) logger.error(`  - ${item}`);
  }
  process.exit(1);
}

const publicCount = Object.keys(PUBLIC_OPERATIONS).length;
logger.info(
  `Public API surface gate: OK — ${publicCount} public operations documented, ${registered.size - publicCount} internal routes.`,
);
