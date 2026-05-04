---
title: "REST API"
description: "HTTP endpoints for browsing orgs, sources, and releases in the index."
adminOnly: false
---

# REST API

Programmatic access to the Releases index via HTTP.

All endpoints are prefixed with `/v1`. By default they return JSON, and paginated list endpoints return `{ items, pagination }`:

```ts
{
  items: T[];
  pagination: {
    page: number;
    pageSize: number;
    returned: number;
    totalItems?: number;
    totalPages?: number;
    hasMore: boolean;
  };
}
```

List endpoints that accept `limit` and `page` default to 500 items per page and cap `limit` at 500 unless noted otherwise.

## Authentication

Read endpoints are public. Write endpoints require a Bearer token:

```bash
curl -H "Authorization: Bearer YOUR_KEY" https://api.releases.sh/v1/...
```

---

## Stats

### `GET /v1/stats`

Returns counts of organizations, sources, releases, and products.

---

## Organizations

### `GET /v1/orgs`

List organizations with source counts and metadata.

| Param   | Description                           |
| ------- | ------------------------------------- |
| `q`     | Substring search on org name or slug  |
| `limit` | Results per page (1-500, default 500) |
| `page`  | Page number (default 1)               |

### `GET /v1/orgs/:slug`

Get organization details including sources, products, and release metrics. The `:slug` segment also accepts an `org_…` typed ID, domain, or account handle — the resolver picks whichever shape was passed.

### `GET /v1/orgs/:slug/accounts`

List social/code-host accounts for the organization.

| Param      | Description                                 |
| ---------- | ------------------------------------------- |
| `platform` | Return the single account for this platform |
| `limit`    | Results per page (1-500, default 500)       |
| `page`     | Page number (default 1)                     |

When `platform` is provided, the endpoint returns a single account or `null` instead of the paginated list envelope.

### `GET /v1/orgs/:slug/tags`

List tags assigned to the organization.

| Param   | Description                           |
| ------- | ------------------------------------- |
| `limit` | Results per page (1-500, default 500) |
| `page`  | Page number (default 1)               |

### `GET /v1/orgs/:slug/ignored-urls`

List org-scoped ignored URLs. Requires a Bearer token.

| Param    | Description                                             |
| -------- | ------------------------------------------------------- |
| `limit`  | Results per page (1-500, default 500)                   |
| `page`   | Page number (default 1)                                 |
| `url`    | URL to test when used with `single=true`                |
| `single` | Return the matching ignored URL row or `null` for `url` |

When `single=true&url=...` is provided, the endpoint returns a single row or `null` instead of the paginated list envelope.

### `GET /v1/orgs/:slug/releases`

Paginated release feed across all sources in the org.

| Param    | Description                              |
| -------- | ---------------------------------------- |
| `cursor` | Pagination cursor from previous response |
| `limit`  | Results per page (1-100, default 20)     |

### `GET /v1/orgs/:slug/activity`

Weekly release activity for the organization.

| Param  | Description             |
| ------ | ----------------------- |
| `from` | Start date (YYYY-MM-DD) |
| `to`   | End date (YYYY-MM-DD)   |

---

## Products

### `GET /v1/products`

List products. Filter with `?orgId=...`.

| Param   | Description                           |
| ------- | ------------------------------------- |
| `orgId` | Filter by organization ID             |
| `limit` | Results per page (1-500, default 500) |
| `page`  | Page number (default 1)               |

### `GET /v1/orgs/:orgSlug/products/:productSlug`

Get product details. Both segments accept an id or a slug. This is the canonical form — prefer it in new clients.

### `GET /v1/products/:slug`

Get product details by typed ID (`prod_…`). Bare slugs return `400 bare_slug_rejected` because slugs are now per-org and ambiguous on the global path. To resolve a bare slug, use `GET /v1/lookups/product-by-slug?slug=<slug>` (returns `{productId, productSlug, orgSlug}`).

---

## Sessions

### `GET /v1/sessions`

List managed-agent discovery/fetch sessions. Requires a Bearer token.

| Param            | Description                                                               |
| ---------------- | ------------------------------------------------------------------------- |
| `status`         | Filter by `running`, `complete`, `error`, or `cancelled`                  |
| `type`           | Filter by `onboard` or `update`                                           |
| `recent_minutes` | Include running sessions and finished sessions updated within this window |
| `limit`          | Results per page (1-500, default 500)                                     |
| `page`           | Page number (default 1)                                                   |

### `GET /v1/sessions/:sessionId`

Get a single session.

### `GET /v1/sessions/:sessionId/logs`

Get status logs for a session.

### `GET /v1/sessions/:sessionId/stdout`

Get captured stdout for a session.

---

## Admin Lists

### `GET /v1/admin/blocklist`

List globally blocked URL patterns. Requires a Bearer token.

| Param    | Description                                           |
| -------- | ----------------------------------------------------- |
| `limit`  | Results per page (1-500, default 500)                 |
| `page`   | Page number (default 1)                               |
| `url`    | URL to test when used with `single=true`              |
| `single` | Return the matching blocklist row or `null` for `url` |

When `single=true&url=...` is provided, the endpoint returns a single row or `null` instead of the paginated list envelope.

---

## Sources

### `GET /v1/sources`

List sources with filters.

| Param         | Description                            |
| ------------- | -------------------------------------- |
| `independent` | Only sources not tied to an org        |
| `orgSlug`     | Filter by organization slug            |
| `productSlug` | Filter by product slug                 |
| `hasFeed`     | Only sources with a feed URL           |
| `query`       | Substring search on name, slug, or URL |
| `category`    | Filter by category                     |

### `GET /v1/orgs/:orgSlug/sources/:sourceSlug`

Source details with paginated releases. Both segments accept an id or a slug. This is the canonical form — prefer it in new clients. The same handler is dual-registered at `/v1/sources/:slug` for typed IDs only; bare slugs there return `400 bare_slug_rejected`. To resolve a bare slug, use `GET /v1/lookups/source-by-slug?slug=<slug>` (returns `{sourceId, sourceSlug, orgSlug}`).

| Param      | Description      |
| ---------- | ---------------- |
| `page`     | Page number      |
| `pageSize` | Results per page |

All `/v1/sources/:slug/...` sub-resources below (`activity`, `recent-releases`, `changelog`, `summaries`, etc.) follow the same rule: typed IDs work on the bare path; slug callers must use the equivalent `/v1/orgs/:orgSlug/sources/:sourceSlug/...` form.

### `GET /v1/sources/:slug/activity`

Weekly release activity for a source. Accepts `from` and `to` date params.

### `GET /v1/sources/:slug/recent-releases`

Releases after a cutoff date. Requires `?cutoff=ISO-date`.

### `GET /v1/sources/:slug/changelog`

Read the canonical `CHANGELOG.md` (or `CHANGES.md` / `HISTORY.md` / `RELEASES.md` / `NEWS.md`) tracked for a GitHub source. Supports heading-aligned range slicing by characters or by tokens (cl100k_base) — useful for agent-friendly Context7-style access to large files (e.g. Apollo Client's 700KB CHANGELOG).

| Param    | Description                                                                                                                                                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `offset` | Character offset into the full file. Snapped forward to the next `##`/`###`/`#` heading unless 0.                                                                                                                                                   |
| `limit`  | Target slice size in **characters**. The slice ends at a heading boundary; overshoots to the next heading if a single section is bigger than `limit`. Default 40000 when either range param is present and `tokens` is not set.                     |
| `tokens` | Target slice size in **tokens** (cl100k_base). Walks sections forward under the budget with the same heading-snap and overshoot rules as `limit`. Takes precedence when both are passed. Recommended brackets: `2000` / `5000` / `10000` / `20000`. |

With no range params, the full file is returned (back-compat). Response body:

```json
{
  "path": "CHANGELOG.md",
  "filename": "CHANGELOG.md",
  "url": "https://github.com/org/repo/blob/HEAD/CHANGELOG.md",
  "rawUrl": "https://raw.githubusercontent.com/org/repo/HEAD/CHANGELOG.md",
  "bytes": 732634,
  "fetchedAt": "2026-04-14T12:17:50.633Z",
  "content": "## 4.1.7\n\n...",
  "offset": 0,
  "limit": 40000,
  "tokens": 5000,
  "nextOffset": 18932,
  "totalChars": 732571,
  "sliceTokens": 4871,
  "totalTokens": 182445
}
```

`totalTokens` is cached per file and always returned. `tokens` (echoed budget) and `sliceTokens` (actual encoded count of the returned `content`) are only populated when the request used token mode.

> **Note:** `totalTokens` is an exact cl100k_base count for files under 256KB. For files above that cap, the value is approximated as `ceil(totalChars / 4)` to keep the upsert path fast. `sliceTokens` is always exact because slices stay under the cap. If you need a precise total for a large file, sum `sliceTokens` across a full walk via `nextOffset`.

Chain successive requests by passing the returned `nextOffset` back as the next `offset`. `nextOffset` is `null` when the slice reaches the end of the file. The canonical file is refreshed on a 24h TTL by the API worker cron for `github` sources.

---

## Releases

### `GET /v1/releases/latest`

Unified feed of the most recent releases. Backs the CLI's `tail`/`latest` command and the public homepage activity feed. The default unfiltered request is cached in KV for 5 minutes (`X-Cache: HIT|MISS`); any request that applies `source`, `org`, a non-default `count`, or `include_coverage=true` bypasses the cache (`X-Cache: BYPASS`) and is served directly from the database.

| Param              | Description                                                                          |
| ------------------ | ------------------------------------------------------------------------------------ |
| `count`            | Max releases to return (1-100, default 10)                                           |
| `source`           | Source slug or id to filter by (mutually exclusive with `org`)                       |
| `org`              | Org slug or id to filter by (mutually exclusive with `source`)                       |
| `include_coverage` | Include coverage-side rows (default `false` — hides duplicate-launch coverage items) |

Coverage-side releases are hidden by default so the feed shows one entry per launch. `source` and `org` both accept either a slug or an id (`src_…`, `org_…`).

### `GET /v1/releases/:id`

Get full release details by ID, including content and media assets.

---

## Search

### `GET /v1/search`

Hybrid search across orgs, products, sources, releases, and CHANGELOG chunks. FTS5 and vector similarity are fused with Reciprocal Rank Fusion; hybrid is the default.

| Param    | Description                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------- |
| `q`      | Search query (required)                                                                             |
| `limit`  | Max results (default 20)                                                                            |
| `offset` | Pagination offset                                                                                   |
| `mode`   | `lexical`, `semantic`, or `hybrid` (default `hybrid`). `lexical` returns the legacy FTS-only shape. |

Hybrid and semantic responses include a ranked `chunks` array interleaved with release hits, plus `mode`, `degraded`, and `degradedReason` fields. `degraded: true` means the request fell back to lexical because Vectorize or the embedding provider was unavailable — results are still returned.

Each chunk hit carries `sourceSlug`, `orgSlug`, `filePath`, `offset`, `length`, `heading`, `snippet`, and `score` so clients can chain into `GET /v1/sources/:slug/changelog?offset=...` for surrounding context.

When the query parses as a `{org}/{repo}` GitHub coordinate **and** no entity (org or catalog source) matched, the response includes a `lookup` field describing the result of an on-demand probe (see [`POST /v1/lookups`](#post-v1lookups)). The optional `github:` prefix is also accepted (e.g. `github:org/repo`). Tangential release / chunk hits do not suppress the lookup — a coordinate is treated as a precise question about one repo. `lookup` is `null` when the query is not coordinate-shaped or when an entity match was returned.

### `POST /v1/lookups`

Materialize a hidden source on demand from a `{org}/{repo}` GitHub coordinate. Used by `/v1/search` (and the MCP `search` / `search_releases` tools) as a fallback when an in-index search returns no hits, but also callable directly.

```bash
curl -X POST https://api.releases.sh/v1/lookups \
  -H "Content-Type: application/json" \
  -d '{"provider": "github", "coordinate": "org/repo"}'
```

| Field        | Description                                                                                                                                                                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`   | Currently only `"github"`.                                                                                                                                                                                                                                                                                      |
| `coordinate` | A `{org}/{repo}` string, optionally prefixed with `github:` (e.g. `github:vercel/next.js`). Other provider prefixes (`npm:`, `gitlab:`, …) are rejected. Org and repo segments are matched case-insensitively against existing rows, so `shopify/toxiproxy` and `Shopify/Toxiproxy` resolve to the same source. |

Five outcomes:

| `status`    | Meaning                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| `indexed`   | New source was just materialized from GitHub. Inline release preview in `releases`.                      |
| `existing`  | Repo was already tracked. Inline release preview in `releases`.                                          |
| `empty`     | Repo exists but has no tagged releases or CHANGELOG yet. Hidden source still created for future polling. |
| `not_found` | No public repo at `github.com/{org}/{repo}` (private, archived, renamed, or never existed).              |
| `deferred`  | GitHub rate-limit or 5xx — transient. No negative cache written; safe to retry shortly.                  |

Response shape:

```ts
{
  status: "indexed" | "existing" | "empty" | "not_found" | "deferred";
  source?: { id, slug, name, url, discovery };
  releases?: Release[];
  relatedOrg: {
    org: { id, slug, name };
    sources: Source[];   // top-5 sibling sources by recent activity
  } | null;
}
```

`relatedOrg` is the "did you mean" rail — populated when the org segment matches a known org but the specific repo doesn't exist or has no releases. It is `null` when the org isn't tracked.

Materialized rows carry `discovery: "on_demand"` and `isHidden: true`. Embeddings still run via `waitUntil` so semantic search picks them up on the next hit; AI features (overviews, summarization, playbook regen) skip on-demand rows. Negative results (`not_found`, `empty`) are cached in KV (`lookup:github:{org}/{repo}`, 24h for `not_found`, 6h for `empty`).

### `GET /v1/lookups/source-by-slug`

Resolve a bare source slug to its canonical org-scoped home. **Requires a Bearer token** — the `/v1/lookups/*` namespace is gated, unlike the rest of the read API. Returns `{sourceId, sourceSlug, orgSlug}`. Useful for old bookmarks and for clients that only have a slug after the bare `/v1/sources/:slug` path stopped accepting them (#698). When a slug exists under multiple orgs, the oldest match by `(createdAt, id)` wins — deterministic across calls. Carries `Sunset: Sun, 01 Nov 2026 00:00:00 GMT`; this is a 6-month migration aid, not a permanent shape.

```bash
curl -H "Authorization: Bearer YOUR_KEY" \
  "https://api.releases.sh/v1/lookups/source-by-slug?slug=vercel-ai-sdk"
# → {"sourceId":"src_…","sourceSlug":"vercel-ai-sdk","orgSlug":"vercel"}
```

### `GET /v1/lookups/product-by-slug`

Same shape as the source resolver, but for products. Returns `{productId, productSlug, orgSlug}`. Same auth requirement and Sunset window.

### `GET /v1/related/releases`

Semantically similar releases for an anchor release. Reuses the release's existing vector — no re-embedding.

| Param     | Description                                              |
| --------- | -------------------------------------------------------- |
| `release` | Anchor release id (required)                             |
| `scope`   | `org` (same organization) or `global` (default `global`) |
| `limit`   | Max results (1-20, default 5)                            |

Degrades to an empty `items` array with `degraded: true` when Vectorize bindings are unavailable. Anchor is excluded from its own results. Cached for 5 minutes.

### `GET /v1/related/sources`

Semantically similar sources for an anchor source. Uses the entity vector.

| Param            | Description                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `source`         | Anchor source slug or id (required)                                                                          |
| `scope`          | `org` (siblings in the same organization) or `global` (default `global`)                                     |
| `excludeOrgSlug` | Optional org slug to exclude from global results (used to avoid overlap when rendering both scopes together) |
| `limit`          | Max results (1-20, default 5)                                                                                |

Same degradation and anchor-exclusion semantics as `/v1/related/releases`.

---

## Summaries

### `GET /v1/sources/:slug/summaries`

Get cached AI summaries for a source.

| Param   | Description                            |
| ------- | -------------------------------------- |
| `type`  | `rolling` or `monthly`                 |
| `year`  | Filter by year (for monthly summaries) |
| `month` | Filter by month                        |

---

## Web URL formats

Every org and source page on `releases.sh` has three machine-readable URL suffixes alongside the HTML:

| Suffix  | Content-Type           | Use case                                                    |
| ------- | ---------------------- | ----------------------------------------------------------- |
| `.json` | `application/json`     | Programmatic / agent consumption                            |
| `.md`   | `text/markdown`        | LLM context, prompt-friendly output                         |
| `.atom` | `application/atom+xml` | Feed readers (Feedly, Inoreader, NetNewsWire), webhook bots |

```
https://releases.sh/anthropic          # HTML
https://releases.sh/anthropic.json     # JSON
https://releases.sh/anthropic.md       # Markdown
https://releases.sh/anthropic.atom     # Atom 1.0 feed
```

The same suffixes work on source pages (`/{org}/{source}.atom`); legacy bare paths (`/source/{slug}.atom`) 308-redirect to the canonical org-scoped form.

Atom feeds include the 50 most recent entries with stable `<id>`s, RFC 3339 timestamps, and HTML-typed content. They respond to `If-None-Match` / `If-Modified-Since` with `304 Not Modified` when unchanged — drop in to any feed reader or polling tool without a custom adapter. The feed is also advertised from each HTML page via `<link rel="alternate" type="application/atom+xml">` for browser auto-discovery.
