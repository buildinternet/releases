/**
 * The public API surface: the operations we document on production, support
 * for third-party callers, and generate SDKs from. Everything else the worker
 * serves is internal — the web app, the CLI's curator/admin commands, agent
 * pipelines, crons — and may change without notice.
 *
 * This list is the single source of truth for that split:
 *   - `/v1/openapi.json` on production includes exactly these operations
 *     (`openapi.ts`); staging keeps every documented route and tags each one
 *     with `x-releases-visibility`.
 *   - `scripts/check-openapi-coverage.ts` fails CI when a public operation is
 *     missing from the spec or lacks a tag, a 2xx response schema, or (for
 *     writes) a request body, and when any registered route is classified as
 *     neither public nor internal.
 *
 * Promotion is deliberate: a new route is internal until it is added here.
 * Keys are `METHOD /hono-style/path` relative to `/v1`, matching `v1.routes`.
 * Org-scoped aliases (#690) are separate operations and are listed explicitly.
 *
 * `auth` is what the spec advertises:
 *   - `"optional"` — anonymous works; a Bearer raises the rate-limit tier.
 *   - `"required"` — a Bearer (`relk_` / `relu_` / OAuth JWT, or the
 *     `releases login` session token on session-only routes) or a web session
 *     cookie. Scope and principal rules are in each operation's description.
 *
 * See docs/architecture/routing.md → Public API surface.
 */
import { adminRoutes } from "./route-namespaces.js";

export type PublicAuth = "optional" | "required";

export const PUBLIC_OPERATIONS: Record<string, PublicAuth> = {
  // ── Catalog reads ──
  "GET /stats": "optional",
  "GET /site-notice": "optional",
  "GET /search": "optional",
  "GET /whats-changed": "optional",
  "GET /related/releases": "optional",
  "GET /related/sources": "optional",

  "GET /orgs": "optional",
  "GET /orgs/:slug": "optional",
  "GET /orgs/:slug/accounts": "optional",
  "GET /orgs/:slug/collections": "optional",
  "GET /orgs/:slug/manifest": "optional",
  "GET /orgs/:slug/overview": "optional",
  "GET /orgs/:slug/products": "optional",
  "GET /orgs/:slug/releases": "optional",
  "GET /orgs/:slug/tags": "optional",
  "GET /orgs/:org/resolve/:slug": "optional",

  "GET /products": "optional",
  "GET /products/:identifier": "optional",
  "GET /products/:identifier/tags": "optional",
  "GET /products/:slug/collections": "optional",
  "GET /products/:slug/overview": "optional",
  "GET /orgs/:orgSlug/products/:productSlug": "optional",
  "GET /orgs/:orgSlug/products/:productSlug/collections": "optional",

  "GET /sources": "optional",
  "GET /sources/:slug": "optional",
  "GET /sources/:slug/releases": "optional",
  "GET /orgs/:orgSlug/sources/:sourceSlug": "optional",
  "GET /orgs/:orgSlug/sources/:sourceSlug/releases": "optional",

  "GET /releases/latest": "optional",
  "GET /releases/:id": "optional",
  "GET /releases/:id/coverage": "optional",

  "GET /categories": "optional",
  "GET /categories/:slug": "optional",
  "GET /categories/:slug/releases": "optional",
  "GET /tags/:slug": "optional",

  "GET /collections": "optional",
  "GET /collections/:slug": "optional",
  "GET /collections/:slug/releases": "optional",
  "GET /collections/:slug/daily-summaries": "optional",
  "GET /collections/:slug/digests": "optional",
  "GET /collections/:slug/digests/latest": "optional",
  "GET /collections/:slug/digests/:weekStart": "optional",

  "GET /lookups/by-domain": "optional",
  "GET /lookups/product-by-slug": "optional",
  "GET /lookups/source-by-coordinate": "optional",
  "GET /lookups/source-by-slug": "optional",
  // On-demand GitHub materialization — `write` scope.
  "POST /lookups": "required",

  // ── Anonymous submissions ──
  "POST /feedback": "optional",
  "POST /recommendations": "optional",

  // ── Self-serve listing + ownership claims (#1947) ──
  "GET /listing/capabilities": "optional",
  "POST /listing/validate": "optional",
  "POST /listing/activate": "optional",
  "POST /listing/claim": "required",
  "POST /listing/claim/verify": "required",
  "GET /listing/claims": "required",
  "DELETE /listing/claims/:id": "required",
  "POST /listing/promote": "required",

  // ── Account (signed-in user) ──
  "POST /api-keys": "required",
  "DELETE /tokens/me": "required",
  "GET /me/workspaces": "required",
  "GET /me/publish-tokens": "required",
  "POST /me/publish-tokens": "required",
  "DELETE /me/publish-tokens/:id": "required",
  "GET /me/semantic-alerts": "required",
  "POST /me/semantic-alerts": "required",
  "GET /me/semantic-alerts/:id": "required",
  "PATCH /me/semantic-alerts/:id": "required",
  "DELETE /me/semantic-alerts/:id": "required",

  // ── Webhooks ── list/get/update/delete/deliveries are still internal until
  // documented; see INTERNAL_OPERATIONS.
  "POST /me/webhooks": "required",
  "POST /me/webhooks/:id/rotate-secret": "required",
  "POST /me/webhooks/:id/test": "required",
  "POST /workspaces/:workspaceId/webhooks": "required",
  "POST /workspaces/:workspaceId/webhooks/:id/rotate-secret": "required",
  "POST /workspaces/:workspaceId/webhooks/:id/test": "required",
};

/**
 * Whole namespaces that are internal: every admin namespace plus worker
 * plumbing that is never a third-party API (inbound provider webhooks, media
 * proxy, email one-click actions, telemetry, the docs page itself).
 */
export const INTERNAL_PREFIXES: readonly string[] = [
  ...adminRoutes,
  "status",
  "admin",
  "inbound",
  "integrations",
  "media",
  "digest",
  "feed",
  "email-actions",
  "telemetry",
  "docs",
  "openapi.json",
];

/**
 * Internal operations inside otherwise-public namespaces. Each group says why
 * it is internal; anything slated for promotion says so.
 */
export const INTERNAL_OPERATIONS = new Set<string>([
  // Web-app aggregation payloads (activity charts, heatmaps, catalog page);
  // shaped for one UI, not general consumers.
  "GET /orgs/:slug/activity",
  "GET /orgs/:slug/heatmap",
  "GET /orgs/:slug/sparklines",
  "GET /orgs/:slug/recent-releases",
  "GET /orgs/:slug/catalog",
  "GET /products/:slug/activity",
  "GET /products/:slug/heatmap",
  "GET /orgs/:orgSlug/products/:productSlug/activity",
  "GET /orgs/:orgSlug/products/:productSlug/heatmap",
  "GET /sources/:slug/activity",
  "GET /sources/:slug/heatmap",
  "GET /orgs/:orgSlug/sources/:sourceSlug/activity",
  "GET /orgs/:orgSlug/sources/:sourceSlug/heatmap",
  "GET /sources/:slug/recent-releases",
  "GET /orgs/:orgSlug/sources/:sourceSlug/recent-releases",
  "GET /sitemap",

  // Ingest / agent-pipeline reads.
  "GET /releases",
  "GET /releases/stream",
  "GET /sources/fetchable",
  "GET /sources/feeds",
  "GET /sources/changes",
  "GET /sources/changelog-files/oversized",
  "GET /sources/:slug/known-releases",
  "GET /orgs/:orgSlug/sources/:sourceSlug/known-releases",
  "GET /sources/:slug/sessions",
  "GET /sources/:slug/summaries",
  "GET /orgs/:slug/overview/inputs",
  "GET /orgs/:slug/playbook",
  "GET /orgs/:slug/ignored-urls",
  // CHANGELOG-file reads: candidates for the public surface once their
  // response shapes are settled.
  "GET /sources/:slug/changelog",
  "GET /orgs/:orgSlug/sources/:sourceSlug/changelog",

  // Curator writes on catalog entities.
  "POST /orgs",
  "PATCH /orgs/:slug",
  "DELETE /orgs/:slug",
  "POST /orgs/stub",
  "POST /orgs/stub-from-domain",
  "POST /orgs/:slug/promote",
  "POST /orgs/:slug/avatar",
  "POST /orgs/:slug/sync-well-known",
  "POST /orgs/:slug/discover-apps",
  "POST /orgs/:slug/accounts",
  "DELETE /orgs/:slug/accounts/:platform/:handle",
  "PUT /orgs/:slug/tags",
  "DELETE /orgs/:slug/tags",
  "POST /orgs/:slug/ignored-urls",
  "DELETE /orgs/:slug/ignored-urls/:url",
  "POST /orgs/:slug/overview",
  "PATCH /orgs/:slug/playbook/notes",
  "GET /orgs/:slug/claims",
  "DELETE /orgs/:slug/claims/:id",
  "POST /tags",
  "POST /products",
  "POST /products/adopt",
  "PATCH /products/:slug",
  "PATCH /orgs/:orgSlug/products/:productSlug",
  "DELETE /products/:identifier",
  "PUT /products/:identifier/tags",
  "DELETE /products/:identifier/tags",
  "POST /sources",
  "POST /sources/appstore",
  "POST /sources/video",
  "PATCH /sources/:slug",
  "PATCH /orgs/:orgSlug/sources/:sourceSlug",
  "DELETE /sources/:slug",
  "POST /sources/:slug/fetch",
  "POST /sources/:slug/firecrawl/sync",
  "POST /sources/:slug/releases",
  "DELETE /sources/:slug/releases",
  "POST /sources/:slug/raw-snapshot",
  "POST /orgs/:orgSlug/sources/:sourceSlug/raw-snapshot",
  "POST /sources/:slug/content-hash",
  "POST /orgs/:orgSlug/sources/:sourceSlug/content-hash",
  "PATCH /sources/:slug/metadata",
  "PATCH /orgs/:orgSlug/sources/:sourceSlug/metadata",
  "PATCH /sources/:slug/changelog/tokens",
  "PATCH /orgs/:orgSlug/sources/:sourceSlug/changelog/tokens",
  "POST /sources/:slug/changelog/probe",
  "POST /orgs/:orgSlug/sources/:sourceSlug/changelog/probe",
  "POST /sources/:slug/summaries",
  "PATCH /releases/:id",
  "DELETE /releases/:id",
  "DELETE /releases/batch",
  "POST /releases/batch-suppress",
  "POST /releases/:id/suppress",
  "POST /releases/:id/unsuppress",
  "POST /releases/:id/coverage",
  "DELETE /releases/:id/coverage",
  "PATCH /categories/:slug",
  "POST /collections",
  "PATCH /collections/:slug",
  "DELETE /collections/:slug",
  "PUT /collections/:slug/members",
  "POST /collections/:slug/members",
  "DELETE /collections/:slug/members/:org",
  "DELETE /collections/:slug/members/products/:product",
  "PUT /site-notice",
  "PATCH /feedback/:id",
  "DELETE /feedback/:id",
  "PATCH /recommendations/:id",
  "DELETE /recommendations/:id",

  // Release publishing: candidate for the public surface (publish tokens,
  // `actions/publish-changelog`) once its request body is modelled.
  "POST /sources/:slug/releases/batch",
  "POST /orgs/:orgSlug/sources/:sourceSlug/releases/batch",

  // Experimental coordinate-based changelog fetch/parse (no persistence).
  "POST /changelog/fetch",
  "POST /changelog/parse",

  // Account routes the web app uses that are not yet documented. Follows,
  // feed and webhook read/update/delete are slated for the public surface.
  "GET /api-keys",
  "DELETE /api-keys/:id",
  "GET /me/follows",
  "POST /me/follows",
  "DELETE /me/follows/:targetType/:targetId",
  "GET /me/feed",
  "GET /me/feed/token",
  "POST /me/feed/token",
  "DELETE /me/feed/token",
  "GET /me/digest",
  "PUT /me/digest",
  "GET /me/collection-digests",
  "PUT /me/collection-digests/:slug",
  "DELETE /me/collection-digests/:slug",
  "GET /me/settings/notifications",
  "GET /me/settings/developer",
  "POST /me/avatar",
  "GET /me/webhooks",
  "GET /me/webhooks/:id",
  "PATCH /me/webhooks/:id",
  "DELETE /me/webhooks/:id",
  "GET /me/webhooks/:id/deliveries",
  "GET /workspaces/:workspaceId/profile",
  "PATCH /workspaces/:workspaceId/profile",
  "POST /workspaces/:workspaceId/avatar",
  "GET /workspaces/:workspaceId/integrations/uploads",
  "POST /workspaces/:workspaceId/integrations/uploads/connect",
  "DELETE /workspaces/:workspaceId/integrations/uploads",
  "GET /workspaces/:workspaceId/webhooks",
  "GET /workspaces/:workspaceId/webhooks/:id",
  "PATCH /workspaces/:workspaceId/webhooks/:id",
  "DELETE /workspaces/:workspaceId/webhooks/:id",
  "GET /workspaces/:workspaceId/webhooks/:id/deliveries",
]);

export type Visibility = "public" | "internal";

/** Classify one registered route; `null` means unclassified (a CI failure). */
export function routeVisibility(method: string, honoPath: string): Visibility | null {
  const key = `${method} ${honoPath}`;
  if (key in PUBLIC_OPERATIONS) return "public";
  if (INTERNAL_OPERATIONS.has(key)) return "internal";
  const isInternalPrefix = INTERNAL_PREFIXES.some(
    (p) => honoPath === `/${p}` || honoPath.startsWith(`/${p}/`),
  );
  return isInternalPrefix ? "internal" : null;
}

/** `/orgs/{slug}` (OpenAPI) → `/orgs/:slug` (Hono). */
export function openapiToHonoPath(path: string): string {
  return path.replace(/\{([A-Za-z0-9_]+)\}/g, ":$1");
}
