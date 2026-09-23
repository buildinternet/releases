# @releases/queries

Shared read queries for the API and MCP workers. Each export is a drizzle query
function (takes a `db` handle, returns rows) or a SQL fragment. No HTTP or MCP
formatting lives here.

Defaults match the API: soft-deleted and hidden rows are excluded. Pass an
explicit option (for example `includeDeleted: true`) when a caller needs
different behavior, and record why in
[docs/architecture/shared-queries.md](../../docs/architecture/shared-queries.md),
which also holds the migration map for the MCP reads that haven't moved yet.

## Exports

Imported as `@releases/queries/<subpath>`.

| Subpath         | Purpose                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------- |
| `entities`      | Resolve orgs, sources, and products by typed ID or `org/slug` coordinate.                     |
| `domain-lookup` | Resolve a normalized domain to its owning org and to products that alias it.                  |
| `sql-fragments` | Reusable fragments: `githubHandleSubquery`, `nullsLastOrderBy`.                               |
| `pagination`    | Page-number window clamp (`resolvePageWindow`) and `slicePage`, shared by REST and MCP lists. |

## Consumers

- `apps/api`: re-exported from `src/utils.ts`, `src/queries/shared.ts`,
  `src/queries/search.ts`, and `src/lib/pagination.ts`, so older import paths
  still work.
- `apps/mcp` (carved out of the root workspaces): resolved through `tsconfig`
  `paths` (`@releases/queries/*` → `../../packages/queries/src/*`) and the root
  `node_modules` symlink at bundle time.

## Tests

`bun test packages/queries`. DB tests use `createTestDb()` from
`tests/db-helper.ts`.

**Private, workspace-only. Not published to npm.**
