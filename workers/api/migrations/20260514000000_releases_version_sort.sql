-- Lexicographically-sortable shadow of `releases.version` so MAX() aggregates
-- pick the semver-highest version instead of the most-recently-published one.
-- Fixes backport-induced "latest version" regressions (e.g. Next.js v15.5.18
-- backport published after v16.x was already out — previously showed v15.5.18
-- as latest).
--
-- Computed in TS via `computeVersionSort()` (`@buildinternet/releases-core/
-- version-sort`) at upsert time. Existing rows are backfilled offline via
-- `scripts/backfill-version-sort.ts` — until then, the aggregate falls back
-- to the previous date-based pick when no rows have a non-null version_sort.
--
-- `releases_visible` is `SELECT releases.*` so SQLite picks up the new column
-- automatically; no view recreation needed.
ALTER TABLE releases ADD COLUMN version_sort TEXT;

-- Indexed because the source-detail aggregate orders by it inside a
-- GROUP BY source_id. Covers `(source_id, version_sort)` lookups.
CREATE INDEX IF NOT EXISTS idx_releases_source_version_sort
  ON releases(source_id, version_sort);
