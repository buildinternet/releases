-- Migration: organizations.fetch_paused (#1057)
-- Adds a per-org ingest pause flag. When true, the org's sources are excluded
-- from poll-fetch and scrape-agent-sweep due-source queries. Public catalog
-- visibility is unaffected — only ingest stops. Default false preserves
-- current behavior for every existing org.

ALTER TABLE organizations ADD COLUMN fetch_paused INTEGER NOT NULL DEFAULT 0;
