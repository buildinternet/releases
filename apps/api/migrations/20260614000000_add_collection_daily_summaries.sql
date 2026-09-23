-- Per-collection daily summary rollups + per-collection enable flag.
ALTER TABLE collections ADD COLUMN daily_summary_enabled INTEGER NOT NULL DEFAULT 1;

CREATE TABLE collection_daily_summaries (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  summary_date TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  takeaways TEXT NOT NULL DEFAULT '[]',
  release_count INTEGER NOT NULL DEFAULT 0,
  model_id TEXT,
  generated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_collection_daily_summaries_day
  ON collection_daily_summaries (collection_id, summary_date);
