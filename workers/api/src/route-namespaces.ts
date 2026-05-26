/**
 * Top-level resource namespaces, split by auth model. Pulled out of `index.ts`
 * so tooling — notably `scripts/check-openapi-coverage.ts` — can import these
 * without dragging in the worker's `cloudflare:workers` re-exports (Durable
 * Objects and Workflows), which Bun can't resolve outside the Workers runtime.
 *
 * Both arrays drive middleware wiring in `index.ts` (`publicReadAuthMiddleware`
 * + rate limit for public-read; `authMiddleware` for admin) and are the source
 * of truth the CI gate uses to decide which registered routes must appear in
 * the OpenAPI document.
 */

/**
 * Public-read namespaces: GET is open to anyone (with rate limiting), writes
 * require auth via `publicReadAuthMiddleware`'s SAFE_METHODS branch.
 */
export const publicReadRoutes = [
  "stats",
  "orgs",
  "sources",
  "search",
  "releases",
  "products",
  "tags",
  "categories",
  "collections",
  "related",
  "sitemap",
  // /lookups: GETs (source-by-slug, product-by-slug, by-domain) are public
  // resolution primitives. POST /v1/lookups (on-demand GitHub indexer) is
  // gated as a write by publicReadAuthMiddleware's SAFE_METHODS check.
  "lookups",
  // /changelog: experimental POST /v1/changelog/fetch (coordinate-based, no
  // persistence). POST → Bearer required via publicReadAuthMiddleware's
  // non-SAFE_METHODS branch, mirroring the source-scoped changelog probe.
  "changelog",
] as const;

/** Admin-only namespaces: every method requires `authMiddleware`. */
export const adminRoutes = [
  "sessions",
  "evaluate",
  "status/fetch-log",
  "status/usage",
  "status/event",
  "admin/blocklist",
  "admin/embed/status",
  "admin/cron-runs",
  "admin/logs",
  "admin/search-queries",
  "admin/feedback",
  "admin/recommendations",
  "admin/overviews",
  "admin/orgs",
  "admin/sources",
  "admin/batch-runs",
  "errata",
  "webhooks",
  "workflows",
  "tokens",
] as const;
