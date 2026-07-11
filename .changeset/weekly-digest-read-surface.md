---
"@buildinternet/releases-api-types": minor
---

Add wire types for the weekly collection digest read surface: `GET /v1/collections/:slug/digests` (list) and `GET /v1/collections/:slug/digests/:weekStart` (detail, with server-resolved covered-release links). Also add an optional `digests` field to the `GET /v1/sitemap` payload.
