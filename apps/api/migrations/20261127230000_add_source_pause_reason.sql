-- Why and when a source's fetch_priority became `paused`.
--
-- Auto-pause writes `unproductive_drains` (flagged drain that extracted 0
-- items, five times) or `extraction_errors` (consecutive deterministic
-- extraction failures). An operator PATCH to `paused` writes `manual`.
-- Both columns are cleared when fetch_priority moves off `paused`.
-- Existing paused rows stay NULL: this migration does not guess a reason
-- for pauses that happened before the columns existed.
--
-- sources_active and sources_visible are `SELECT *` views frozen at create
-- time, so they must be dropped and recreated to surface the new columns
-- (same pattern as 20260703030000_add_source_unproductive_drains.sql).
ALTER TABLE sources ADD COLUMN paused_reason TEXT;
ALTER TABLE sources ADD COLUMN paused_at TEXT;

DROP VIEW IF EXISTS sources_visible;
DROP VIEW IF EXISTS sources_active;

CREATE VIEW IF NOT EXISTS sources_active AS
  SELECT * FROM sources WHERE deleted_at IS NULL;

CREATE VIEW IF NOT EXISTS sources_visible AS
  SELECT * FROM sources_active WHERE is_hidden = 0;
