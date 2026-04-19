---
title: "REST API"
adminOnly: false
---

# REST API

Programmatic access to the Releases index via HTTP.

All endpoints are prefixed with `/v1` and return JSON.

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

List all organizations with source counts and metadata.

### `GET /v1/orgs/:slug`

Get organization details including sources, products, and release metrics.

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

### `GET /v1/products/:slug`

Get product details by slug or ID.

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

### `GET /v1/sources/:slug`

Source details with paginated releases.

| Param      | Description      |
| ---------- | ---------------- |
| `page`     | Page number      |
| `pageSize` | Results per page |

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

### `GET /v1/summaries`

Get cached AI summaries for a source.

| Param        | Description                             |
| ------------ | --------------------------------------- |
| `sourceSlug` | Source slug (required, or use sourceId) |
| `type`       | `rolling` or `monthly`                  |
| `year`       | Filter by year (for monthly summaries)  |
| `month`      | Filter by month                         |

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

The same suffixes work on source pages (`/{org}/{source}.atom`) and standalone sources (`/source/{slug}.atom`).

Atom feeds include the 50 most recent entries with stable `<id>`s, RFC 3339 timestamps, and HTML-typed content. They respond to `If-None-Match` / `If-Modified-Since` with `304 Not Modified` when unchanged — drop in to any feed reader or polling tool without a custom adapter. The feed is also advertised from each HTML page via `<link rel="alternate" type="application/atom+xml">` for browser auto-discovery.
