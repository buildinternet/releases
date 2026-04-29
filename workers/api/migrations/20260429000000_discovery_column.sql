-- 20260429000000_discovery_column.sql
-- Adds a `discovery` column to organizations and sources to mark how the row
-- was created. Values: 'curated' (default for everything pre-existing),
-- 'agent' (created by the discovery agent), 'on_demand' (created by the
-- on-demand /v1/lookups endpoint).
--
-- The column is queryable so admin tooling and AI-feature gates can filter
-- by discovery origin without parsing JSON metadata.
--
-- DEFAULT 'curated' causes existing rows to inherit the curated value
-- automatically, so no separate UPDATE backfill is needed.

ALTER TABLE organizations ADD COLUMN discovery TEXT NOT NULL DEFAULT 'curated';
ALTER TABLE sources ADD COLUMN discovery TEXT NOT NULL DEFAULT 'curated';

CREATE INDEX idx_organizations_discovery ON organizations(discovery);
CREATE INDEX idx_sources_discovery ON sources(discovery);
