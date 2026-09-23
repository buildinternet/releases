-- GitHub star counts on sources. Two nullable columns + an index. Both
-- sources_active and sources_visible are `SELECT *` views frozen at create
-- time, so they must be dropped and recreated to surface the new columns
-- (same pattern as 20260525000000_add_products_avatar_url.sql). Drop the
-- dependent view (sources_visible) first, then the base view, then recreate.
ALTER TABLE sources ADD COLUMN stargazers_count INTEGER;
ALTER TABLE sources ADD COLUMN stars_fetched_at TEXT;

CREATE INDEX IF NOT EXISTS idx_sources_stargazers_count
  ON sources(stargazers_count) WHERE stargazers_count IS NOT NULL;

DROP VIEW IF EXISTS sources_visible;
DROP VIEW IF EXISTS sources_active;

CREATE VIEW IF NOT EXISTS sources_active AS
  SELECT * FROM sources WHERE deleted_at IS NULL;

CREATE VIEW IF NOT EXISTS sources_visible AS
  SELECT * FROM sources_active WHERE is_hidden = 0;
