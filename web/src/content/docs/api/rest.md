---
title: "REST API"
description: "HTTP endpoints for browsing orgs, sources, and releases in the index."
adminOnly: false
---

# REST API

Programmatic access to the Releases index over HTTP. The notes below cover conventions that apply across endpoints; the per-endpoint reference is generated from the OpenAPI spec.

- **Interactive reference:** [`api.releases.sh/v1/docs`](https://api.releases.sh/v1/docs) — full Scalar reference with request/response shapes, examples, and client snippets.
- **OpenAPI 3.1 spec:** [`api.releases.sh/v1/openapi.json`](https://api.releases.sh/v1/openapi.json) — source of truth, generated from the worker's route annotations.
- **Base URL:** `https://api.releases.sh/v1`
- **Webhooks:** [Webhooks](/docs/api/webhooks) — self-serve outbound `release.created` delivery (org-scoped or follows-filtered).

## Authentication

Read endpoints are public. Write endpoints require a Bearer token:

```bash
curl -H "Authorization: Bearer YOUR_KEY" https://api.releases.sh/v1/...
```

## Pagination

Three shapes, picked per surface:

| Shape            | Surfaces                                                                                                                                                                                                                                 | Input                                                 | Output                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Page-based**   | Catalog-shaped: `/v1/sources`, `/v1/orgs`, `/v1/products`, `/v1/collections`                                                                                                                                                             | `page` + `limit` (default and max `500` unless noted) | `{ items, pagination }`, where `pagination: { page, pageSize, returned, totalItems, totalPages, hasMore }` |
| **Cursor-based** | Feed-shaped: `/v1/orgs/:slug/releases`, `/v1/orgs/:orgSlug/sources/:sourceSlug` (and its embedded `releases` array), `/v1/orgs/:orgSlug/sources/:sourceSlug/releases`, `/v1/collections/:slug/releases`, `/v1/categories/:slug/releases` | opaque `cursor`                                       | `pagination: { nextCursor, limit }`; `nextCursor` is `null` when the slice is exhausted                    |
| **Search**       | `/v1/search`, `/v1/search/releases`                                                                                                                                                                                                      | query + `limit`                                       | `_meta.search`, with `hitCap: true` when results saturated `limit`                                         |

## Release date filtering

`/v1/search` and `/v1/releases/latest` accept optional `since` and `until` query params that bound results by publish date. Each takes an ISO date/datetime (`2026-01-01`) or relative shorthand (`90d`, `4w`, `6m`, `2y`); an unparseable value is a `400`. On `/v1/search` they filter the release hits only — the orgs, catalog, and collections sections are unaffected — and releases with no `published_at` are dropped from the window.

```bash
curl "https://api.releases.sh/v1/search?q=slack%20integration&since=90d"
curl "https://api.releases.sh/v1/releases/latest?org=vercel&since=2026-01-01&until=2026-03-31"
```

## Resource shape

| Resource     | Notes                                                                                                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Orgs**     | Publish releases. Resolved by typed ID (`org_…`) or slug.                                                                                                                                                                   |
| **Products** | Optional grouping layer between orgs and sources.                                                                                                                                                                           |
| **Sources**  | Changelog endpoints owned by an org. `type` is one of `github`, `scrape`, `feed`, `agent`. Resolved by typed ID (`src_…`) on the bare path, or by slug under the org-scoped path (`/v1/orgs/:orgSlug/sources/:sourceSlug`). |
| **Releases** | Carry `id`, `orgId`, `sourceId`, `title`, `version`, `publishedAt`, `url`, `description`, `media`, plus optional `summary`, `title_generated`, `title_short`.                                                               |

IDs are immutable; prefer them over slugs.

## Lookups

When you only have a coordinate or a domain:

| Endpoint                                                          | Resolves                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /v1/lookups/by-domain?domain=…`                              | A normalized domain to its owning org and any products whose alias targets the same domain. |
| `GET /v1/lookups/source-by-slug?slug=…`                           | The canonical org-scoped home for a bare source slug.                                       |
| `GET /v1/lookups/product-by-slug?slug=…`                          | The canonical org-scoped home for a bare product slug.                                      |
| `POST /v1/lookups { provider: "github", coordinate: "org/repo" }` | Materializes a hidden source row from a GitHub coordinate on first call.                    |

## Discoverability

- The API is advertised by RFC 9727 at [`/.well-known/api-catalog`](/.well-known/api-catalog).
- The OpenAPI 3.1 spec is the source of truth: [`https://api.releases.sh/v1/openapi.json`](https://api.releases.sh/v1/openapi.json).
- Every org and source page on `releases.sh` has machine-readable URL suffixes: `.json` (programmatic), `.md` (LLM-friendly), `.atom` (feed readers).

```
https://releases.sh/anthropic          # HTML
https://releases.sh/anthropic.json     # JSON
https://releases.sh/anthropic.md       # Markdown
https://releases.sh/anthropic.atom     # Atom 1.0 feed
```

Legacy bare paths (`/source/{slug}.atom`) 308-redirect to the canonical org-scoped form.
