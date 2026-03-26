# Organizations for Released

## Problem

Sources are currently flat — each changelog source exists independently with no way to group them by company or product family. A multi-product company like Vercel (Next.js, Turbopack, v0, etc.) has no structural relationship between its sources. Users cannot query "what changed across all Vercel products" or look up all changelogs for a company by domain.

## Solution

Add an `organizations` concept that groups sources under a company identity. Organizations have a primary domain and linked accounts across platforms (GitHub, X, etc.). Sources optionally belong to an organization. Queries can filter by organization to aggregate across all of a company's products.

## Data Model

### `organizations` table

| Column       | Type   | Constraints              |
|-------------|--------|--------------------------|
| `id`        | TEXT   | PK, `org_` nanoid prefix |
| `name`      | TEXT   | NOT NULL                 |
| `slug`      | TEXT   | NOT NULL, UNIQUE         |
| `domain`    | TEXT   | UNIQUE (when non-null)   |
| `created_at`| TEXT   | NOT NULL                 |

### `org_accounts` table

| Column       | Type   | Constraints                                    |
|-------------|--------|------------------------------------------------|
| `id`        | TEXT   | PK, `oa_` nanoid prefix                       |
| `org_id`    | TEXT   | NOT NULL, FK → organizations.id, CASCADE DELETE |
| `platform`  | TEXT   | NOT NULL (github, x, linkedin, website, etc.)  |
| `handle`    | TEXT   | NOT NULL                                       |
| `created_at`| TEXT   | NOT NULL                                       |
| UNIQUE      |        | `(platform, handle)`                           |

### `sources` table changes

Add column:
- `org_id` TEXT, FK → organizations.id, SET NULL on delete

Index: `idx_sources_org` on `sources.org_id` — supports the common query pattern of filtering sources by organization.

SET NULL (not CASCADE) ensures deleting an org does not destroy its sources — they simply become unaffiliated.

## Organization Lookup

A shared `findOrg(identifier)` helper in `src/db/queries.ts` resolves an organization from any of its identifiers. Resolution order:

1. `organizations.slug` (exact match)
2. `organizations.domain` (exact match)
3. `organizations.name` (case-insensitive, `LIMIT 1 ORDER BY created_at ASC` for determinism if names are not unique)
4. `org_accounts.handle` (exact match)

First match wins. Steps are evaluated in order — the function returns as soon as a match is found. All CLI commands and MCP tools that accept an org identifier use this resolver. This includes `--org` on `released add`, `org show`, `org remove`, `org link`, `org unlink`, and the `--org` filter on query commands.

## New Query Helpers

Added to `src/db/queries.ts`:

- `findOrg(identifier: string): Promise<Organization | null>` — multi-field org lookup as described above
- `getSourcesByOrg(orgId: string): Promise<Source[]>` — all sources belonging to an org
- `getRecentReleasesByOrg(orgId: string, cutoffIso: string): Promise<Array<Release & { sourceName: string; sourceSlug: string }>>` — releases across all of an org's sources with source attribution, ordered by `published_at` descending. Joins sources to include name/slug so callers (like `summary --org`) can attribute releases to specific products in AI input.

## CLI Commands

### Organization management

- `released org add "<name>" [--domain <domain>] [--slug <slug>]` — creates org; slug auto-derived via `toSlug()` if not provided. Errors on slug collision.
- `released org list [--query <text>] [--platform <platform>]` — table of orgs, filterable by substring match (`LIKE %query%`) across name, slug, domain, and account handles, or by platform presence
- `released org show <identifier>` — org details via `findOrg()`: domain, linked accounts, linked sources
- `released org remove <identifier>` — resolves via `findOrg()`, then deletes the org. FK constraints handle cleanup: `CASCADE DELETE` removes accounts, `SET NULL` unlinks sources.
- `released org link <identifier> --platform <platform> --handle <handle>` — adds an account
- `released org unlink <identifier> --platform <platform> --handle <handle>` — removes an account

All org commands support `--json` for machine-readable output.

### Source command changes

`released add` gains an optional `--org <name-or-slug>` flag:
- Resolves via `findOrg()`. If found, links the source to it.
- If not found, derives a slug via `toSlug()` and checks for slug collision. If a slug collision occurs, falls back to finding the existing org by that slug instead of erroring. If no collision, creates a stub org (name + slug only, no domain) and links.

### Auto-association for GitHub sources

When `released add` is called with a GitHub URL and no `--org` flag:

1. Parse the owner from the URL (e.g., `vercel` from `github.com/vercel/next.js`)
2. Look up `org_accounts` for `platform = 'github'` and `handle = <owner>`
3. If found, auto-link the source to that org and log the association
4. If not found, create the source without an org

No auto-association for scrape sources — URL-to-org mapping is too unreliable.

### Query command changes

Existing commands gain an optional `--org <identifier>` filter, resolved via `findOrg()`:

- `released latest --org <identifier>` — latest releases across all of an org's sources
- `released search <query> --org <identifier>` — FTS filtered to org's sources
- `released summary --org <identifier>` — AI summary across all of an org's sources, using `getRecentReleasesByOrg()`

## MCP Tool Changes

### New tool: `list_organizations`

Parameters:
- `query` (optional, string) — substring search across org name, slug, domain, and account handles
- `platform` (optional, string) — filter to orgs with an account on that platform

### Modified tools

- `list_products` — gains optional `organization` parameter (resolved via `findOrg()`) to filter sources
- `search_releases` — gains optional `organization` parameter
- `get_latest_releases` — gains optional `organization` parameter

The `organization` parameter on all MCP tools accepts any org identifier (slug, domain, name, or account handle) and resolves via `findOrg()`.

## Migration

- Schema version bumps from 1 to 2 via `PRAGMA user_version`
- v1 → v2 migration block:
  - `CREATE TABLE IF NOT EXISTS organizations (...)`
  - `CREATE TABLE IF NOT EXISTS org_accounts (...)`
  - `ALTER TABLE sources ADD COLUMN org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL`
  - `CREATE INDEX IF NOT EXISTS idx_sources_org ON sources(org_id)`
  - `PRAGMA user_version = 2`
- The `ALTER TABLE` is wrapped in try/catch because SQLite has no `ALTER TABLE ... IF NOT EXISTS` syntax — if the migration ran partially (tables created but `user_version` not yet bumped), the column may already exist on retry. The `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` statements are inherently idempotent and do not need try/catch.
- No data migration needed — organizations are populated going forward

## ID Conventions

Following the established nanoid pattern:
- Organizations: `org_` prefix
- Org accounts: `oa_` prefix
- Sources: `src_` prefix (existing)
- Releases: `rel_` prefix (existing)
