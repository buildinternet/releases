# @buildinternet/releases-sdk

## 0.2.1

### Patch Changes

- Updated dependencies [3c599a5]
  - @buildinternet/releases-api-types@0.60.1

## 0.2.0

### Minor Changes

- 30f025f: The CLI now sends its public API calls (follows, the personalized feed, webhooks, workspaces, release reads, collections, search, domain lookup, changelogs and overviews) through `@buildinternet/releases-sdk`. `releases feed` pages with `--cursor` instead of `--page`, which the API rejects. `releases search` gains `--org`.

  The API now honors three filters the CLI already sent: `org` on `GET /v1/search` (slug or `org_…` id, echoed as `org` / `orgStatus`), `platform` on `GET /v1/orgs`, and `minImportance` on `GET /v1/orgs/:slug/releases`. The SDK's `SearchQuery`, `OrgListQuery` and `OrgReleasesQuery` take them, and api-types adds `org` / `orgStatus` to the search response. Rows of the org and collection release feeds now type `id` as always present, matching what the API returns.

### Patch Changes

- Updated dependencies [2ff1665]
- Updated dependencies [30f025f]
- Updated dependencies [144c828]
- Updated dependencies [21331d2]
- Updated dependencies [f5266f4]
- Updated dependencies [2e256e2]
  - @buildinternet/releases-api-types@0.60.0
