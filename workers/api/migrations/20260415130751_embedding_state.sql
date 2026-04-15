-- Mirrors src/db/migrations/20260415115816_parallel_kate_bishop.sql
CREATE TABLE source_changelog_chunks (
  id TEXT PRIMARY KEY NOT NULL,
  source_changelog_file_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  offset INTEGER NOT NULL,
  length INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  heading TEXT,
  vector_id TEXT,
  embedded_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_changelog_file_id) REFERENCES source_changelog_files(id) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON UPDATE NO ACTION ON DELETE CASCADE
);

CREATE UNIQUE INDEX scc_file_offset_uq ON source_changelog_chunks (source_changelog_file_id, offset);
CREATE INDEX idx_scc_file ON source_changelog_chunks (source_changelog_file_id);
CREATE INDEX idx_scc_source ON source_changelog_chunks (source_id);
CREATE INDEX idx_scc_content_hash ON source_changelog_chunks (content_hash);

ALTER TABLE organizations ADD COLUMN embedded_at TEXT;
ALTER TABLE products ADD COLUMN embedded_at TEXT;
ALTER TABLE releases ADD COLUMN embedded_at TEXT;
ALTER TABLE sources ADD COLUMN embedded_at TEXT;
