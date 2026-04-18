-- Cadence observability columns written by the daily retier job.
-- median_gap_days: median gap between consecutive publishedAt values over
-- the last 180 days of non-suppressed releases; null when <3 releases of
-- signal. last_retiered_at: last time the retier evaluated this source.
ALTER TABLE sources ADD COLUMN median_gap_days REAL;
ALTER TABLE sources ADD COLUMN last_retiered_at TEXT;
