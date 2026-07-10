---
"@buildinternet/releases-api-types": minor
---

Add `?category=` and `?collection=` scoping to `GET /v1/search`. `category` narrows orgs, catalog, and release hits to organizations in a fixed category slug (unknown → 400); `collection` narrows to a curated collection's member orgs (unknown → empty envelope with `collectionStatus: "not_found"`). Both compose with every existing filter. `UnifiedSearchResponseSchema` gains optional `category` / `categoryStatus` and `collection` / `collectionStatus` echo fields, mirroring the existing `domain` / `domainStatus` shape.
