---
"@buildinternet/releases": minor
"@buildinternet/releases-api-types": minor
"@buildinternet/releases-sdk": minor
---

The CLI now sends its public API calls (follows, the personalized feed, webhooks, workspaces, release reads, collections, search, domain lookup, changelogs and overviews) through `@buildinternet/releases-sdk`. `releases feed` pages with `--cursor` instead of `--page`, which the API rejects. `releases search` gains `--org`.

The API now honors three filters the CLI already sent: `org` on `GET /v1/search` (slug or `org_…` id, echoed as `org` / `orgStatus`), `platform` on `GET /v1/orgs`, and `minImportance` on `GET /v1/orgs/:slug/releases`. The SDK's `SearchQuery`, `OrgListQuery` and `OrgReleasesQuery` take them, and api-types adds `org` / `orgStatus` to the search response. Rows of the org and collection release feeds now type `id` as always present, matching what the API returns.
