-- Partial indexes on deleted_at for the tombstone sweep cron (#666).
--
-- The nightly sweep-tombstones cron runs `WHERE deleted_at IS NOT NULL AND
-- deleted_at < ?` against organizations, sources, and products to find aged
-- tombstones. Without an index, each table is full-scanned on every fire.
-- Today that's cheap because no rows are tombstoned; left unindexed, it grows
-- linearly with both row count and steady-state tombstone backlog.
--
-- Partial form (`WHERE deleted_at IS NOT NULL`) keeps the index trivially
-- small — it only contains tombstoned rows, which by design are the minority.
-- IS NULL reads (the read-path "skip tombstones" filter) don't benefit from
-- an index since the predicate isn't selective; the planner correctly stays
-- on the existing per-query indexes (org_id, source_id, etc.) and applies
-- the IS NULL filter as a post-scan check.

CREATE INDEX IF NOT EXISTS idx_sources_deleted_at
  ON sources(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_organizations_deleted_at
  ON organizations(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_deleted_at
  ON products(deleted_at) WHERE deleted_at IS NOT NULL;
