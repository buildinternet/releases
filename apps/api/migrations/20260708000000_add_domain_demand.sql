-- workers/api/migrations/20260708000000_add_domain_demand.sql
-- Demand signal for the manifest sweep (#1947). One row per domain that a
-- /lookups/by-domain call failed to resolve; the daily well-known tick probes
-- the highest-demand unlisted domains for a valid /.well-known/releases.json and
-- creates a stub org for any that have one. Internal-only (no public api-types).
-- Timestamps are epoch millis. swept_at NULL = never probed (the due-filter clock).
CREATE TABLE domain_demand (
  domain TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 1,
  swept_at INTEGER
);
CREATE INDEX idx_domain_demand_hitcount_swept ON domain_demand (hit_count, swept_at);
