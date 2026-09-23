# Shared read queries (`packages/queries`)

Working doc and migration map for moving the MCP worker's inline reads onto the
same query functions the API worker uses. Status: slice 1 landed.

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
- **Defaults follow the API.** Where MCP differs, the MCP call site passes an
  explicit option (e.g. `includeDeleted: true`) and the difference is listed
  under [Open decisions](#open-decisions). Unifying never silently changes MCP
  output.

## Modules (slice 1)

| Module          | Exports                                                                                                                                                                                                       | API consumers                                                  | MCP consumers                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------- |
| `entities`      | `orgWhere`, `sourceById`, `productById`, `sourceMatchByIdOrSlug`, `productMatchByIdOrSlug`, `findSourceById`, `findProductById`, `findSourceForOrgSlug`, `findProductForOrgSlug`, `isSourceId`, `isProductId` | `utils.ts` re-exports (routes, GraphQL, `resolve*FromContext`) | `resolveSource`, `resolveProduct` (typed ID + `org/slug`) |
| `domain-lookup` | `findOrgByDomain`, `findProductsByDomain`                                                                                                                                                                     | `/v1/lookups/by-domain`, `/v1/search?domain=`, org create      | `lookup_domain`                                           |
| `sql-fragments` | `githubHandleSubquery`, `nullsLastOrderBy`                                                                                                                                                                    | `queries/shared.ts` re-exports                                 | `get_latest_releases`, `get_release`                      |
| `pagination`    | `resolvePageWindow`, `slicePage`, `PageWindow`                                                                                                                                                                | `parseListPagination`                                          | `parseMcpPagination`, `list_catalog`                      |

`apps/mcp/src/lib/pagination.ts` stays: it holds MCP-only rendering (markdown
footer, `_meta.pagination`, the `get_latest_releases` cursor token, `_meta.search`).
Its parse and slice logic now delegates to the package.

## Migration map

Legend: **same** = same query, move as-is · **drift** = same read, different
filters or shape (API is the reference) · **mcp-only** = no API equivalent ·
**shared** = already in a shared package · **done** = migrated in slice 1.

| MCP read (tool or helper)                                                              | Nearest API equivalent                                                    | Class    | Notes                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveSource` / `resolveProduct`, typed ID + `org/slug`                              | `utils.ts` `findSourceForOrgSlug` / `findProductForOrgSlug`, `sourceById` | **done** | MCP keeps tombstones resolvable (D1). Coordinate branch now also accepts `org_…` / `src_…` / `prod_…` segments (additive).                                                                     |
| `lookup_domain` org + products                                                         | `findOrgByDomain`, by-domain route products query                         | **done** | Identical queries. No output change.                                                                                                                                                           |
| `get_latest_releases`, `get_release` GitHub-handle subquery                            | `githubHandleSubquery`                                                    | **done** | Identical SQL.                                                                                                                                                                                 |
| `parseMcpPagination`, `slicePage`                                                      | `parseListPagination`, `slicePage`                                        | **done** | Identical clamp math; defaults stay per surface (MCP 50/200, REST `DEFAULT_PAGE_SIZE`).                                                                                                        |
| `resolveSource` / `resolveProduct`, bare slug                                          | `/v1/lookups/{source,product}-by-slug`                                    | mcp-only | API: oldest match over `*_active`. MCP: enumerates every match (incl. deleted) and throws `AmbiguousEntityError` (#1324). Surface policy; keep in MCP, but the enumerate query could move.     |
| `findOrg` (id / slug / domain / name / alias / handle UNION)                           | `orgWhere` (id / slug), `findOrgByDomain`                                 | mcp-only | No deleted or hidden filter (D2). Used by 4 tools. Candidate: `findOrgByAnyIdentifier` in `entities` with API filters as default.                                                              |
| `resolveEntityToSourceIds` (product → source IDs, slug fan-out)                        | `?product=` expansion in `getOrgReleasesFeed`                             | drift    | MCP includes deleted and hidden sources in the ID list; downstream queries re-filter hidden but not deleted.                                                                                   |
| `get_latest_releases` main query                                                       | `getLatestReleasesAcross`, `getOrgReleasesFeed`                           | drift    | D3. Also: cursor token format differs from `core-internal/feed-cursor`; ORDER BY lacks the `fetched_at` tiebreak; MCP-only `product` / `type` / `kind` filters; API-only `excludeSourceTypes`. |
| `get_latest_releases` org → source IDs                                                 | `LatestReleasesFilter.orgId` (`s.org_id = ?`)                             | drift    | MCP pre-fetches IDs from `sources` (incl. deleted) then `IN (…)`; API filters in SQL.                                                                                                          |
| `list_organizations`                                                                   | `getOrgsWithStats` + `countOrgsForList`                                   | drift    | D4. MCP `query` also matches domain, alias, and account handle; `platform` filter is MCP-only.                                                                                                 |
| `get_organization` (accounts, tags, sources, products, aliases, overview, collections) | `GET /v1/orgs/:slug` handler (inline in `routes/orgs.ts`)                 | drift    | Products: MCP uses `products` + `EXISTS sources_visible`, API `products_active` + same EXISTS (deleted products leak on MCP). Org via `findOrg` (D2).                                          |
| `get_organization` / `lookup_domain` stub release locations                            | `loadReleaseLocations` (`lib/well-known/read-locations.ts`)               | drift    | Same filter; MCP orders `canonical DESC, match_key`, API `match_key` only. Easy next slice.                                                                                                    |
| `get_release`                                                                          | `GET /v1/releases/:id` handler (`routes/sources.ts`)                      | drift    | D5.                                                                                                                                                                                            |
| `renderSourceDetail` (org, product, release count, changelog files)                    | `GET /v1/sources/:id`, `/changelog` route                                 | drift    | Org and product name lookups use base tables (deleted parents still named). Changelog file queries match the API.                                                                              |
| `renderProductDetail` (org, sources, tags)                                             | `GET /v1/products/:id`                                                    | drift    | Product's source list has no hidden or deleted filter (D6).                                                                                                                                    |
| `list_catalog` products + standalone sources                                           | `GET /v1/orgs/:slug/catalog`                                              | drift    | MCP reads `products` / `sources` base tables: deleted products and deleted standalone sources are listed (D6). Kind filter semantics match.                                                    |
| `search` org candidates                                                                | `searchOrgs` (`queries/search.ts`)                                        | drift    | MCP: `organizations` base table, matches `category` too, no `is_hidden` / deleted filter (D2).                                                                                                 |
| `search` catalog candidates (products, sources)                                        | catalog branch of `/v1/search`                                            | drift    | Close: both use `products_active` / `sources_visible`. MCP joins `organizations` (not `_active`). Verify before moving.                                                                        |
| `search` collections direct + member rollups                                           | `searchCollectionsDirect`, member-rollup query in `queries/search.ts`     | same     | Same `organizations_public` gates. Good next-slice candidate.                                                                                                                                  |
| `search` lexical releases                                                              | `searchReleasesFts`                                                       | shared   | `@releases/search/releases-fts`.                                                                                                                                                               |
| `search` hybrid + collections semantic                                                 | `runHybridSearch`, `runCollectionsSemantic`                               | shared   | `@releases/search/hybrid-search-worker`.                                                                                                                                                       |
| `search` product scope (product → source IDs, org slug echo)                           | —                                                                         | drift    | Same issue as `resolveEntityToSourceIds`.                                                                                                                                                      |
| `list_collections`                                                                     | `getCollectionsList`                                                      | drift    | Same member-count subqueries. MCP paginates in SQL and ignores `featured`; API returns all.                                                                                                    |
| `get_collection` (row + org and product members)                                       | `getCollectionBySlug` + `getCollectionFullMembers`                        | same     | Same joins and gates. Good next-slice candidate.                                                                                                                                               |
| `get_collection_releases` member IDs                                                   | collection route member-ID lookup                                         | same     |                                                                                                                                                                                                |
| `get_collection_releases` feed                                                         | `getCollectionReleasesFeed`                                               | shared   | `@releases/core-internal/collection-feed`.                                                                                                                                                     |
| `getCollectionsForOrg`                                                                 | —                                                                         | mcp-only | Plain `collection_members` join; no visibility gate needed (collections are public).                                                                                                           |
| `slug-completion.ts` (org, product, source completions)                                | —                                                                         | mcp-only | MCP prompt-argument completion. Reads base tables, so tombstoned slugs are suggested.                                                                                                          |
| `whats-changed-tool.ts` importance by version                                          | —                                                                         | mcp-only | Enrichment over the API proxy response.                                                                                                                                                        |
| `auth.ts` token verification                                                           | `@releases/core-internal/api-token-store`                                 | shared   |                                                                                                                                                                                                |

Remaining after slice 1: 22 rows not yet shared (14 drift, 3 same, 5
mcp-only). The `drift` rows need a decision below before they move.

## Open decisions

Each is a place where MCP returns rows the API hides. Slice 1 preserved MCP
behavior; flipping any of these changes MCP output.

- **D1. Soft-deleted sources and products in MCP entity resolution.**
  `resolveSource` / `resolveProduct` pass `includeDeleted: true`
  (`MCP_RESOLVE_OPTS` in `tools.ts`), so a tombstoned `src_…`, `prod_…`, or
  `org/slug` still resolves in `get_catalog_entry`, `get_latest_releases`
  `product`, and `search` `entity` / `product`. The API returns 404. Recommend
  dropping the option.
- **D2. `findOrg` has no deleted or hidden filter.** A tombstoned org (slug
  mangled to `<slug>--<id>`) resolves by id, name, domain, alias, or handle. A
  hidden org resolves too. The API hides both from its directory and 404s
  deleted orgs.
- **D3. `get_latest_releases` visibility.** MCP does not drop releases whose
  org is hidden or soft-deleted, and joins `sources` / `products` rather than
  `sources_active` / `products_active`. The API drops all of them.
- **D4. `list_organizations` visibility.** MCP lists hidden orgs, and lists a
  soft-deleted org whose sources are still visible. The API filters
  `o.is_hidden = 0` and reads `organizations_active`.
- **D5. `get_release` visibility.** MCP returns coverage-side releases (the
  API 404s them via `releases_visible`), keeps org and product names for
  deleted parents (the API returns `org: null` / `product: null`), and returns
  a release whose source row is missing (the API 404s).
- **D6. Catalog and product detail list deleted children.** `list_catalog` and
  `renderProductDetail` read base tables, so deleted products and deleted or
  hidden sources appear.

## Next slices

1. `get_collection`, collection member IDs, collection direct/member-rollup
   search: same queries, no decisions needed.
2. Release locations: move `loadReleaseLocations`, pick one ORDER BY.
3. After D1/D2: `findOrg` → `entities.findOrgByAnyIdentifier`; bare-slug
   enumerate → `entities`.
4. After D3: one latest-releases query in the package, with the MCP filters as
   options and one cursor format.
5. After D4–D6: org directory, catalog, `get_release`, source and product detail.
