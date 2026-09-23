-- Drain cooldown marker (#1862). Stamped by the OrgActor on a successful
-- managed-agent /update dispatch; queryCandidates excludes sources drained
-- within DRAIN_COOLDOWN_MS so a permanently-flagged, un-fetchable scrape/agent
-- source can't re-drain (and re-bill a no-op Haiku session) every 4h poll tick.
-- NULL = never drained through the actor path (default, preserves old behavior).
--
-- sources_active and sources_visible are `SELECT *` views frozen at create time,
-- so they must be dropped and recreated to surface the new column (same pattern
-- as 20260602000000_add_sources_stargazers.sql). Drop the dependent view
-- (sources_visible) first, then the base view, then recreate both.
ALTER TABLE sources ADD COLUMN last_drain_at TEXT;

DROP VIEW IF EXISTS sources_visible;
DROP VIEW IF EXISTS sources_active;

CREATE VIEW IF NOT EXISTS sources_active AS
  SELECT * FROM sources WHERE deleted_at IS NULL;

CREATE VIEW IF NOT EXISTS sources_visible AS
  SELECT * FROM sources_active WHERE is_hidden = 0;
