---
title: "REST API"
description: "HTTP endpoints for browsing orgs, sources, and releases in the index."
adminOnly: false
---

# REST API

Programmatic access to the Releases index over HTTP. Every public-read endpoint is documented in the live OpenAPI 3.1 spec at [`api.releases.sh/v1/openapi.json`](https://api.releases.sh/v1/openapi.json) and rendered as an interactive reference at [`/docs/api/rest`](/docs/api/rest) (this page) and [`api.releases.sh/v1/docs`](https://api.releases.sh/v1/docs).

The page you are reading is auto-generated from the OpenAPI spec, so it stays in sync with what the API worker actually serves. The notes below cover conventions that apply across endpoints.

## Authentication

Read endpoints are public. Write endpoints require a Bearer token:

```bash
curl -H "Authorization: Bearer YOUR_KEY" https://api.releases.sh/v1/...
```

## Pagination

Two shapes, picked per surface:

- **Page-based** (catalog-shaped surfaces: `/v1/sources`, `/v1/orgs`, `/v1/products`, `/v1/collections`, `/v1/categories/:slug/releases`) — `page` + `limit` inputs, `{ items, pagination }` output with `pagination: { page, pageSize, returned, totalItems, totalPages, hasMore }`. Default and max `limit` is 500 unless noted otherwise.
- **Cursor-based** (feed-shaped surfaces: `/v1/orgs/:slug/releases`, `/v1/collections/:slug/releases`) — opaque `cursor` input, `nextCursor` output.

Search endpoints (`/v1/search`, `/v1/search/releases`) attach `_meta.search` instead, with `hitCap: true` when results saturated `limit`.

## Resource shape

- **Orgs** publish releases. Resolved by typed ID (`org_…`) or slug.
- **Products** are an optional grouping layer between orgs and sources.
- **Sources** are changelog endpoints owned by an org. Type is one of `github`, `scrape`, `feed`, `agent`. Resolved by typed ID (`src_…`) on the bare path or by slug under the org-scoped path (`/v1/orgs/:orgSlug/sources/:sourceSlug`).
- **Releases** carry `id`, `orgId`, `sourceId`, `title`, `version`, `publishedAt`, `url`, `description`, `media`, plus optional `summary`, `title_generated`, `title_short`.

IDs are immutable; prefer them over slugs.

## Lookups

Two GET resolvers help when you only have a coordinate or domain:

- `GET /v1/lookups/by-domain?domain=…` — resolves a normalized domain to its owning org and any products whose alias targets the same domain.
- `GET /v1/lookups/source-by-slug?slug=…` / `GET /v1/lookups/product-by-slug?slug=…` — returns the canonical org-scoped home for a bare slug.
- `POST /v1/lookups { provider: "github", coordinate: "org/repo" }` — materializes a hidden source row from a GitHub coordinate on first call.

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
