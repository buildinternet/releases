-- Release summaries table
CREATE TABLE IF NOT EXISTS release_summaries (
  id TEXT PRIMARY KEY,
  source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('rolling', 'monthly')),
  year INTEGER,
  month INTEGER,
  window_days INTEGER,
  summary TEXT NOT NULL,
  release_count INTEGER NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_unique
  ON release_summaries(source_id, org_id, type, year, month);
CREATE INDEX IF NOT EXISTS idx_summaries_source_type
  ON release_summaries(source_id, type);
CREATE INDEX IF NOT EXISTS idx_summaries_org_type
  ON release_summaries(org_id, type);

-- Add metadata to organizations
ALTER TABLE organizations ADD COLUMN metadata TEXT DEFAULT '{}';
