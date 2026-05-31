-- Raw page snapshots table: stores R2 keys + content hashes for per-source
-- page snapshots captured during backfill workflows. Supports idempotent
-- upsert via the (source_id, content_hash) unique index. (#1281)
CREATE TABLE source_raw_snapshots (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  format TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_raw_snapshots_source ON source_raw_snapshots (source_id, created_at);
CREATE UNIQUE INDEX uq_raw_snapshots_source_hash ON source_raw_snapshots (source_id, content_hash);
