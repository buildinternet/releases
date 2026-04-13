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
