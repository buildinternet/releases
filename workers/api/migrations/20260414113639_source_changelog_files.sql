-- Mirrors src/db/migrations/20260414113639_flashy_silver_fox.sql
CREATE TABLE source_changelog_files (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL,
  path TEXT NOT NULL,
  filename TEXT NOT NULL,
  url TEXT NOT NULL,
  raw_url TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON UPDATE NO ACTION ON DELETE CASCADE
);

CREATE UNIQUE INDEX scf_source_path_uq ON source_changelog_files (source_id, path);
CREATE INDEX idx_scf_source ON source_changelog_files (source_id);
