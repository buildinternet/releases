-- Backs the per-source window query in getStuckSources (the "Stuck Sources"
-- admin report / dashboard tab): ROW_NUMBER() OVER (PARTITION BY source_id
-- ORDER BY created_at DESC). The single-column idx_fetch_log_source can't
-- service the ordered partition without a per-source sort over the full
-- fetch_log history.
CREATE INDEX IF NOT EXISTS idx_fetch_log_source_created
  ON fetch_log (source_id, created_at);
