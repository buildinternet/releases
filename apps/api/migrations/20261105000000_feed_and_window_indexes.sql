-- Two read-path indexes on `releases`, each replacing an older one.
--
-- 1. minImportance feed (`GET /v1/releases/latest?minImportance=`, MCP
--    `get_latest_releases`). The old partial index led with `importance`, so
--    `importance >= ?` seeked every scored row at or above the bar, joined and
--    ran the per-row subqueries (coverage count, GitHub handle) for all of
--    them, then sorted to keep 20 — about 3.4 s in prod. This one is in the
--    feed's own order (`published_at DESC, fetched_at DESC, id DESC`) with
--    `importance` alongside, so SQLite walks newest-first, rejects low scores
--    from the index entry, and stops at LIMIT. Still partial: `importance >= ?`
--    implies `importance IS NOT NULL`, and unscored history stays out of it.
--
-- 2. Window counts (the hourly /v1/stats rollup's "releases in the last N
--    days" per source). `idx_releases_published (published_at)` made every row
--    in the window a table read for `source_id` / `suppressed` / `id`. The
--    wider index covers them, so a published_at range read is index-only apart
--    from the release_coverage probe. Same leading column, so any query that
--    used the old index can use this one.
--
-- New indexes are built before the old ones are dropped.

CREATE INDEX IF NOT EXISTS idx_releases_scored_feed
  ON releases (published_at DESC, fetched_at DESC, id DESC, importance)
  WHERE importance IS NOT NULL;
DROP INDEX IF EXISTS idx_releases_importance_published;

CREATE INDEX IF NOT EXISTS idx_releases_published_source
  ON releases (published_at, source_id, suppressed, id);
DROP INDEX IF EXISTS idx_releases_published;
