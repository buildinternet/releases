# Shared read queries (`packages/queries`)

Working doc and migration map for moving the MCP worker's inline reads onto the
same query functions the API worker uses. Status: slices 1–6 landed;
decisions D1–D12 resolved (MCP visibility now matches the API).

## Why

`apps/mcp/src/tools.ts` carried its own copy of most read paths (~60 inline
`db.select` / `db.all` / raw `sql` call sites, plus a few in `slug-completion.ts`
and `whats-changed-tool.ts`). The API has the same reads under
`apps/api/src/queries/` and in route handlers. The copies drifted: MCP often
skips the soft-delete and hidden filters the API applies. A filter change had to
land in two or three places.

## Shape

- **Package:** `packages/queries`, imported as `@releases/queries/<module>`.
  Private, workspace-only. Not `packages/core` (published, consumed by the OSS
  CLI) and not `packages/core-internal` (a grab-bag of webhook, hashing, and
  batch helpers; a read layer deserves one obvious home).
- **Unit:** drizzle query functions that take a `db` handle (`AnyDb` from
  `@releases/lib/db`) and return rows. No HTTP, MCP, or markdown formatting.
  Both workers use drizzle over D1, so a function is a better seam than the raw
  SQL constants used in `~/Code/sunny`: callers can't re-assemble the query
  with different filters.
- **Wiring:** root workspace member (`packages/*`). `apps/api` and `apps/mcp`
  map `@releases/queries/*` to `../../packages/queries/src/*` in `tsconfig`
  `paths`. Wrangler resolves it through the root `node_modules/@releases/queries`
  symlink, the same way `@releases/search` resolves for the carved-out MCP
  worker. No MCP lockfile change.
- **API side:** `apps/api/src/queries/*` stays the API's module layout. Moved
  functions are re-exported from their old paths (`utils.ts`,
  `queries/shared.ts`, `queries/search.ts`, `lib/pagination.ts`) so existing
  import sites keep working. New shared reads go straight into the package.
- **Defaults follow the API.** MCP calls the package with the API's
  visibility defaults. `includeDeleted: true` is for admin paths only (hard
  purge, restore). See [Resolved decisions](#resolved-decisions).

## Modules

| Module              | Exports                                                                                                                                                                                                       | API consumers                                                                         | MCP consumers                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `entities`          | `orgWhere`, `sourceById`, `productById`, `sourceMatchByIdOrSlug`, `productMatchByIdOrSlug`, `findSourceById`, `findProductById`, `findSourceForOrgSlug`, `findProductForOrgSlug`, `isSourceId`, `isProductId` | `utils.ts` re-exports (routes, GraphQL, `resolve*FromContext`)                        | `resolveSource`, `resolveProduct` (typed ID + `org/slug`)                           |
| `domain-lookup`     | `findOrgByDomain`, `findProductsByDomain`                                                                                                                                                                     | `/v1/lookups/by-domain`, `/v1/search?domain=`, org create                             | `lookup_domain`                                                                     |
| `sql-fragments`     | `githubHandleSubquery`, `nullsLastOrderBy`                                                                                                                                                                    | `queries/shared.ts` re-exports                                                        | `get_latest_releases`, `get_release`                                                |
| `pagination`        | `resolvePageWindow`, `slicePage`, `PageWindow`                                                                                                                                                                | `parseListPagination`                                                                 | `parseMcpPagination`, `list_catalog`                                                |
| `orgs`              | `findOrgByAnyIdentifier`, `listOrgDirectoryPage`, `listOrgVisibleProducts`, `orgHasVisibleRelease`                                                                                                            | —, `GET /v1/orgs/:slug` products                                                      | every tool that resolves an org, `list_organizations`, `search`, `get_organization` |
| `releases`          | `findVisibleReleaseDetail`, `listLatestReleases`                                                                                                                                                              | `GET /v1/releases/:id`                                                                | `get_release`, `get_latest_releases`                                                |
| `catalog`           | `listProductSources`, `listCatalogProducts`, `listCatalogStandaloneSources`                                                                                                                                   | `buildProductDetailPayload` (`GET /v1/products/:id`)                                  | product detail, `list_catalog`                                                      |
| `collections`       | `findCollectionBySlug`, `countCollections`, `listCollectionsWhere`, `listCollectionMemberIds`, `getCollectionFullMembers`, `interleaveMembers`, `searchCollectionsDirect`, `findCollectionsByMemberOrgs`      | `queries/collections.ts` + `queries/search.ts` re-exports, collection routes, GraphQL | `list_collections`, `get_collection`, `get_collection_releases`, `search`           |
| `release-locations` | `listReleaseLocationRows`, `mapReleaseLocation`, `loadReleaseLocations`                                                                                                                                       | `GET /v1/orgs/:slug`, `/v1/lookups`, GraphQL `Org.releaseLocations`                   | `get_organization`, `lookup_domain` stub reads                                      |
| `search-entities`   | `searchOrgs`, `searchProducts`, `searchSources`, `ScopeOpts`                                                                                                                                                  | `queries/search.ts` re-exports, `/v1/search`                                          | `search` org and catalog candidates                                                 |

`apps/mcp/src/lib/pagination.ts` stays: it holds MCP-only rendering (markdown
footer, `_meta.pagination`, `_meta.search`) and the `get_latest_releases`
cursor decoder, which reads the shared feed cursor plus the old base64url token.
Its parse and slice logic now delegates to the package.

## Migration map

Legend: **same** = same query, move as-is · **drift** = same read, different
filters or shape (API is the reference) · **mcp-only** = no API equivalent ·
**shared** = already in a shared package · **done** = migrated (slice 1 or 2).

| MCP read (tool or helper)                                                              | Nearest API equivalent                                                    | Class    | Notes                                                                                                                                                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveSource` / `resolveProduct`, typed ID + `org/slug`                              | `utils.ts` `findSourceForOrgSlug` / `findProductForOrgSlug`, `sourceById` | **done** | Soft-deleted rows no longer resolve (D1). Coordinate branch also accepts `org_…` / `src_…` / `prod_…` segments (additive).                                                         |
| `lookup_domain` org + products                                                         | `findOrgByDomain`, by-domain route products query                         | **done** | Identical queries. No output change.                                                                                                                                               |
| `get_latest_releases`, `get_release` GitHub-handle subquery                            | `githubHandleSubquery`                                                    | **done** | Identical SQL.                                                                                                                                                                     |
| `parseMcpPagination`, `slicePage`                                                      | `parseListPagination`, `slicePage`                                        | **done** | Identical clamp math; defaults stay per surface (MCP 50/200, REST `DEFAULT_PAGE_SIZE`).                                                                                            |
| `resolveSource` / `resolveProduct`, bare slug                                          | `/v1/lookups/{source,product}-by-slug`                                    | **done** | Enumeration is `listSourcesBySlug` / `listProductsBySlug` (D9). The API picks the oldest match, MCP throws `AmbiguousEntityError` (#1324): surface policy.                         |
| `findOrg` (id / slug / domain / name / alias / handle UNION)                           | `orgWhere` (id / slug), `findOrgByDomain`                                 | **done** | `findOrgByAnyIdentifier` over `organizations_active` (D2). Hidden orgs still resolve.                                                                                              |
| `resolveEntityToSourceIds` (product → source IDs, slug fan-out)                        | `?product=` expansion in `getOrgReleasesFeed`                             | drift    | MCP includes deleted and hidden sources in the ID list; downstream queries re-filter hidden but not deleted.                                                                       |
| `get_latest_releases` main query                                                       | `getLatestReleasesAcross`, `getOrgReleasesFeed`                           | **done** | `listLatestReleases` (D3). `getLatestReleasesAcross` is now a snake_case wrapper over it.                                                                                          |
| `get_latest_releases` org → source IDs                                                 | `LatestReleasesFilter.orgId` (`s.org_id = ?`)                             | **done** | Filters `s.org_id` in SQL, like the API.                                                                                                                                           |
| `list_organizations`                                                                   | `getOrgsWithStats` + `countOrgsForList`                                   | **done** | `listOrgDirectoryPage` (D4). Broader `query` match and `platform` filter stay MCP-only.                                                                                            |
| `get_organization` (accounts, tags, sources, products, aliases, overview, collections) | `GET /v1/orgs/:slug` handler (inline in `routes/orgs.ts`)                 | **done** | Products via `listOrgVisibleProducts` (D12). Org via `findOrgByAnyIdentifier`. Accounts, tags, aliases, and overview reads are identical inline.                                   |
| `get_organization` / `lookup_domain` stub release locations                            | `loadReleaseLocations`                                                    | **done** | `listReleaseLocationRows` / `loadReleaseLocations` (D8), one ORDER BY in SQL.                                                                                                      |
| `get_release`                                                                          | `GET /v1/releases/:id` handler (`routes/sources.ts`)                      | **done** | `findVisibleReleaseDetail`, used by both (D5).                                                                                                                                     |
| `renderSourceDetail` (org, product, release count, changelog files)                    | `GET /v1/sources/:id`, `/changelog` route                                 | drift    | Org and product name lookups use base tables (deleted parents still named). Changelog file queries match the API.                                                                  |
| `renderProductDetail` (org, sources, tags)                                             | `GET /v1/products/:id`                                                    | **done** | Source list via `listProductSources`, used by both (D6). Org and tag lookups still inline.                                                                                         |
| `list_catalog` products + standalone sources                                           | `GET /v1/orgs/:slug/catalog`                                              | **done** | `listCatalogProducts` / `listCatalogStandaloneSources` (D6). Shape differs from the API (cross-org, standalone-only sources), so the API keeps its own query.                      |
| `search` org candidates                                                                | `searchOrgs`                                                              | **done** | Shared `searchOrgs` (D10).                                                                                                                                                         |
| `search` catalog candidates (products, sources)                                        | catalog branch of `/v1/search`                                            | **done** | Shared `searchProducts` / `searchSources` (D11).                                                                                                                                   |
| `search` collections direct + member rollups                                           | `searchCollectionsDirect`, `findCollectionsByMemberOrgs`                  | **done** | Both workers call the package functions (slice 2).                                                                                                                                 |
| `search` lexical releases                                                              | `searchReleasesFts`                                                       | shared   | `@releases/search/releases-fts`.                                                                                                                                                   |
| `search` hybrid + collections semantic                                                 | `runHybridSearch`, `runCollectionsSemantic`                               | shared   | `@releases/search/hybrid-search-worker`.                                                                                                                                           |
| `search` product scope (product → source IDs, org slug echo)                           | —                                                                         | drift    | Same issue as `resolveEntityToSourceIds`.                                                                                                                                          |
| `list_collections`                                                                     | `listCollectionsWhere`                                                    | **done** | Shares the member-count query (`listCollectionsWhere` + `countCollections`, slice 2). MCP still pages in SQL and ignores `featured`; the API's preview-member list stays API-only. |
| `get_collection` (row + org and product members)                                       | `findCollectionBySlug` + `getCollectionFullMembers`                       | **done** | One member list for the REST route, GraphQL, and MCP (slice 2).                                                                                                                    |
| `get_collection_releases` member IDs                                                   | `listCollectionMemberIds`                                                 | **done** | MCP now gates product members through a visible parent org (D7).                                                                                                                   |
| `get_collection_releases` feed                                                         | `getCollectionReleasesFeed`                                               | shared   | `@releases/core-internal/collection-feed`.                                                                                                                                         |
| `getCollectionsForOrg`                                                                 | —                                                                         | mcp-only | Plain `collection_members` join; no visibility gate needed (collections are public).                                                                                               |
| `slug-completion.ts` (org, product, source completions)                                | —                                                                         | mcp-only | Reads `organizations_active` (not hidden), `products_active`, and `sources_visible`, so deleted and hidden entries aren't suggested.                                               |
| `whats-changed-tool.ts` importance by version                                          | —                                                                         | mcp-only | Enrichment over the API proxy response.                                                                                                                                            |
| `auth.ts` token verification                                                           | `@releases/core-internal/api-token-store`                                 | shared   |                                                                                                                                                                                    |

## Resolved decisions

D1–D7 and D9–D12 were places where MCP returned rows the API hides; D8 was an
ordering difference. All twelve now match the API;
`apps/mcp/test/visibility-parity.test.ts` holds a regression test for each.

- **D1.** `MCP_RESOLVE_OPTS` is gone: soft-deleted sources and products no
  longer resolve by typed ID, `org/slug`, or bare slug.
- **D2.** `findOrg` → `findOrgByAnyIdentifier`: soft-deleted orgs never match
  on any key; hidden orgs still resolve by direct lookup, as in
  `GET /v1/orgs/:slug`.
- **D3.** `get_latest_releases` → `listLatestReleases`: reads `sources_active`
  and `products_active` and drops releases under hidden or deleted orgs.
- **D4.** `list_organizations` → `listOrgDirectoryPage`: reads
  `organizations_active` with `is_hidden = 0`.
- **D5.** `get_release` → `findVisibleReleaseDetail` (shared with the API
  route): coverage-side releases and releases without a visible source are
  not found; deleted org or product parents come back null.
- **D6.** `list_catalog` and product detail read `products_active`,
  `sources_visible`, and `organizations_active`. A visible source whose
  product was deleted now lists as standalone.
- **D7.** `get_collection_releases` → `listCollectionMemberIds`: a product
  member whose parent org is on_demand or soft-deleted no longer contributes
  releases, matching `GET /v1/collections/:slug/releases`. Note that
  `organizations_public` keeps hidden orgs, so a hidden org is still a visible
  collection member on both surfaces.
- **D8.** Stub release locations → `@releases/queries/release-locations`:
  both workers read `ORDER BY canonical DESC, match_key` in SQL. The API used
  to sort `match_key` in SQL and hoist canonical rows in JS, so its output is
  unchanged.
- **D9.** Bare-slug enumeration → `listSourcesBySlug` / `listProductsBySlug`
  in `entities`: joins `organizations_active` like
  `/v1/lookups/{source,product}-by-slug`, so a live source or product under a
  soft-deleted org no longer resolves by bare slug. The ambiguity policy
  stays in MCP.
- **D10.** `search` org candidates → `searchOrgs` (`search-entities`): reads
  `organizations_active`, so a soft-deleted org no longer matches, even with
  `include_empty`.
- **D11.** `search` catalog candidates → `searchProducts` / `searchSources`:
  products need a visible source and a live org; source org columns come
  from `organizations_active`.
- **D12.** `get_organization` products → `listOrgVisibleProducts`: reads
  `products_active`, so a soft-deleted product with a visible source no
  longer lists.

Latest-releases slice (no D-number: the API is the side that changed, and its
output is the same):

- `GET /v1/releases/latest` and MCP `get_latest_releases` both run
  `listLatestReleases`. The order is dated first, then `published_at`,
  `fetched_at`, `id` descending, as in every REST feed.
- MCP pages on the REST feed cursor (`publishedAt|fetchedAt|id`,
  `buildFeedCursor`). Old base64url `publishedAt|id` tokens still decode as the
  legacy 2-part cursor. The old MCP keyset re-admitted dated rows once paging
  reached undated releases; the shared keyset keeps the undated tail closed.
- `parseFeedCursorKey` (`core-internal/feed-cursor`) is the one cursor parser;
  `feedCursorSql`, the API's raw-D1 `parseFeedCursor`, and
  `listLatestReleases` all read through it.
- `GET /v1/orgs/:slug` and `/orgs/:slug/sparklines` no longer resolve a
  soft-deleted org through a domain alias.

Remaining differences, not yet decided:

- `resolveEntityToSourceIds` and the `search` product scope still list deleted
  and hidden source IDs; downstream reads re-filter them.
- `renderSourceDetail` parent names read the base `organizations` and
  `products` tables, so a deleted parent is still named. `GET /v1/sources/:id`
  does the same, so this is consistent, not drift; change both or neither.
- The `search` product scope lists every source ID under the product, deleted
  and hidden included. `/v1/search?product=` expands the same way.

## Next slices

1. Decide the two consistent-but-loose reads above (source detail parent
   names, product-scope source IDs) together with the API.
