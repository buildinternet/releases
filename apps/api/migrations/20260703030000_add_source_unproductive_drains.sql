-- Unproductive-drain counter (#1862). Incremented when a scrape/agent source
-- that was flagged (change_detected_at set) drains but finds 0 new releases;
-- reset on a productive drain. At UNPRODUCTIVE_DRAIN_PAUSE_AFTER the source is
-- auto-paused (fetch-log.ts) so a permanently broken/flapping source stops
-- re-billing a no-op Haiku /update every cycle instead of draining forever.
-- Sibling of consecutive_errors, which only fires on hard extraction errors and
-- so never catches a source that "successfully finds nothing".
--
-- sources_active and sources_visible are `SELECT *` views frozen at create time,
-- so they must be dropped and recreated to surface the new column (same pattern
-- as 20260703020000_add_source_last_drain_at.sql). Drop the dependent view
-- (sources_visible) first, then the base view, then recreate both.
ALTER TABLE sources ADD COLUMN unproductive_drains INTEGER DEFAULT 0;

DROP VIEW IF EXISTS sources_visible;
DROP VIEW IF EXISTS sources_active;

CREATE VIEW IF NOT EXISTS sources_active AS
  SELECT * FROM sources WHERE deleted_at IS NULL;

CREATE VIEW IF NOT EXISTS sources_visible AS
  SELECT * FROM sources_active WHERE is_hidden = 0;
