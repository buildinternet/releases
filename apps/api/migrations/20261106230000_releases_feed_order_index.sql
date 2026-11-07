-- Full feed-order index for the cross-source latest feed.
--
-- `GET /v1/releases/latest` (and MCP `get_latest_releases`) orders by
-- `published_at DESC, fetched_at DESC, id DESC`. No index matched that order
-- (`idx_releases_published_id` skips `fetched_at`), so a sort was unavoidable,
-- and the planner chose to start from `sources`, read every release and sort
-- them all to keep 20. The cache-bypassing `since` / `until` / `exclude`
-- shapes paid that on every call. With this index, and the unscoped query
-- written as a CROSS JOIN so `releases` stays the outer loop, SQLite walks
-- newest-first and stops at LIMIT.
--
-- `idx_releases_published_id (published_at DESC, id DESC)` stays. The GraphQL
-- homepage ticker orders by exactly `(published_at DESC, id DESC)` with an
-- `OR published_at IS NULL` filter; with the old index gone and no
-- `sqlite_stat1`, SQLite fell back to a MULTI-INDEX OR plus a full sort
-- (0.6 ms to ~500 ms on a 150K-row fixture), so dropping it is not safe.

CREATE INDEX IF NOT EXISTS idx_releases_feed_order
  ON releases (published_at DESC, fetched_at DESC, id DESC);
