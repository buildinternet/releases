-- Media asset registry for R2-hosted images and videos
CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  r2_key TEXT UNIQUE NOT NULL,
  source_url TEXT NOT NULL,
  source_filename TEXT,
  content_type TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  release_id TEXT REFERENCES releases(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(content_hash)
);
CREATE INDEX idx_media_assets_source ON media_assets(source_id);
CREATE INDEX idx_media_assets_release ON media_assets(release_id);
CREATE INDEX idx_media_assets_hash ON media_assets(content_hash);
