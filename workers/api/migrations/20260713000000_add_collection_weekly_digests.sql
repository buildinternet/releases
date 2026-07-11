-- Weekly collection digest content surface (WS3 PR A): one AI-written
-- "mini blog post" per (collection, ET week), plus the per-collection
-- opt-in gate for the nightly generation. Additive; no backfill here — the
-- launch backfill runs via POST /v1/workflows/backfill-weekly-digests.

ALTER TABLE collections ADD COLUMN weekly_digest_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE collection_weekly_digests (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  week_start TEXT NOT NULL,
  title TEXT NOT NULL,
  intro TEXT NOT NULL,
  body TEXT NOT NULL,
  release_ids TEXT NOT NULL DEFAULT '[]',
  release_count INTEGER NOT NULL DEFAULT 0,
  model_id TEXT,
  generated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_collection_weekly_digests_week ON collection_weekly_digests (collection_id, week_start);
