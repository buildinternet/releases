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

| Param | Description |
| --- | --- |
| `cursor` | Pagination cursor from previous response |
| `limit` | Results per page (1-100, default 20) |

### `GET /v1/orgs/:slug/activity`

Weekly release activity for the organization.

| Param | Description |
| --- | --- |
| `from` | Start date (YYYY-MM-DD) |
| `to` | End date (YYYY-MM-DD) |

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

| Param | Description |
| --- | --- |
| `independent` | Only sources not tied to an org |
| `orgSlug` | Filter by organization slug |
| `productSlug` | Filter by product slug |
| `hasFeed` | Only sources with a feed URL |
| `query` | Substring search on name, slug, or URL |
| `category` | Filter by category |

### `GET /v1/sources/:slug`

Source details with paginated releases.

| Param | Description |
| --- | --- |
| `page` | Page number |
| `pageSize` | Results per page |

### `GET /v1/sources/:slug/activity`

Weekly release activity for a source. Accepts `from` and `to` date params.

### `GET /v1/sources/:slug/recent-releases`

Releases after a cutoff date. Requires `?cutoff=ISO-date`.

### `GET /v1/sources/:slug/changelog`

Read the canonical `CHANGELOG.md` (or `CHANGES.md` / `HISTORY.md` / `RELEASES.md` / `NEWS.md`) tracked for a GitHub source. Supports heading-aligned range slicing — useful for agent-friendly Context7-style access to large files (e.g. Apollo Client's 700KB CHANGELOG).

| Param | Description |
| --- | --- |
| `offset` | Character offset into the full file. Snapped forward to the next `##`/`###`/`#` heading unless 0. |
| `limit` | Target slice size in characters. The slice ends at a heading boundary; overshoots to the next heading if a single section is bigger than `limit`. Default 40000 when either range param is present. |

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
  "nextOffset": 40234,
  "totalChars": 732571
}
```

Chain successive requests by passing the returned `nextOffset` back as the next `offset`. `nextOffset` is `null` when the slice reaches the end of the file. The canonical file is refreshed on a 24h TTL by the API worker cron for `github` sources.

---

## Releases

### `GET /v1/releases/:id`

Get full release details by ID, including content and media assets.

---

## Search

### `GET /v1/search`

Full-text search across orgs, products, sources, and releases.

| Param | Description |
| --- | --- |
| `q` | Search query (required) |
| `limit` | Max results (default 20) |
| `offset` | Pagination offset |

---

## Summaries

### `GET /v1/summaries`

Get cached AI summaries for a source.

| Param | Description |
| --- | --- |
| `sourceSlug` | Source slug (required, or use sourceId) |
| `type` | `rolling` or `monthly` |
| `year` | Filter by year (for monthly summaries) |
| `month` | Filter by month |
