-- Make org_id nullable on release_summaries (sources without orgs can have summaries too)
-- SQLite doesn't support ALTER COLUMN, so we recreate the table

CREATE TABLE IF NOT EXISTS release_summaries_new (
  id TEXT PRIMARY KEY,
  source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
  org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('rolling', 'monthly')),
  year INTEGER,
  month INTEGER,
  window_days INTEGER,
  summary TEXT NOT NULL,
  release_count INTEGER NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO release_summaries_new SELECT * FROM release_summaries;

DROP TABLE release_summaries;
ALTER TABLE release_summaries_new RENAME TO release_summaries;

CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_unique
  ON release_summaries(source_id, org_id, type, year, month);
CREATE INDEX IF NOT EXISTS idx_summaries_source_type
  ON release_summaries(source_id, type);
CREATE INDEX IF NOT EXISTS idx_summaries_org_type
  ON release_summaries(org_id, type);
