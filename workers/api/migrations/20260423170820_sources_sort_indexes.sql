-- Back the /status Sources-tab ORDER BY variants. Without these, each sort
-- change is a full scan of the sources table. Schema definition in
-- packages/core/src/schema.ts.
CREATE INDEX IF NOT EXISTS idx_sources_name ON sources (name);
CREATE INDEX IF NOT EXISTS idx_sources_last_fetched_at ON sources (last_fetched_at);
CREATE INDEX IF NOT EXISTS idx_sources_median_gap_days ON sources (median_gap_days);
