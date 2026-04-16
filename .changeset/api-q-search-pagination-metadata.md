---
"@buildinternet/releases": minor
---

Add server-side `?q=` search on `GET /v1/sources` and `GET /v1/orgs`, `?limit=`/`?offset=`/`?page=` pagination on `GET /v1/sources` (default 100, cap 500), and confirm `metadata` is accepted by `PATCH /v1/sources/:slug`. CLI `releases list --limit`/`--page` now pushes pagination to the server instead of fetching all results client-side.
