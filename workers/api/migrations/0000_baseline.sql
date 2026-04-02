-- Squashed baseline: full schema as of 2026-04-02
-- Replaces migrations 0000-0014

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  domain TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  description TEXT,
  category TEXT
);

CREATE TABLE org_accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  handle TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url TEXT,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  category TEXT
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  url TEXT NOT NULL,
  org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  last_fetched_at TEXT,
  last_content_hash TEXT,
  fetch_priority TEXT DEFAULT 'normal',
  consecutive_no_change INTEGER DEFAULT 0,
  consecutive_errors INTEGER DEFAULT 0,
  next_fetch_after TEXT,
  is_primary INTEGER DEFAULT 0,
  is_hidden INTEGER DEFAULT 0
);

CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  version TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_summary TEXT,
  url TEXT,
  content_hash TEXT,
  metadata TEXT DEFAULT '{}',
  published_at TEXT,
  fetched_at TEXT NOT NULL,
  suppressed INTEGER DEFAULT 0,
  suppressed_reason TEXT,
  media TEXT DEFAULT '[]'
);

CREATE TABLE release_summaries (
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

CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  r2_key TEXT UNIQUE NOT NULL,
  source_url TEXT NOT NULL,
  source_filename TEXT,
  content_type TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  release_id TEXT REFERENCES releases(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE fetch_log (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  releases_found INTEGER NOT NULL,
  releases_inserted INTEGER NOT NULL,
  duration_ms INTEGER,
  status TEXT NOT NULL,
  error TEXT,
  raw_content TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  source_slug TEXT,
  release_count INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE blocked_urls (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'exact',
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ignored_urls (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  reason TEXT,
  ignored_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE org_tags (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE product_tags (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

-- FTS5 for full-text search on releases
CREATE VIRTUAL TABLE IF NOT EXISTS releases_fts USING fts5(
  title, content, content_summary,
  content='releases', content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS releases_ai AFTER INSERT ON releases BEGIN
  INSERT INTO releases_fts(rowid, title, content, content_summary)
  VALUES (new.rowid, new.title, new.content, new.content_summary);
END;

CREATE TRIGGER IF NOT EXISTS releases_ad AFTER DELETE ON releases BEGIN
  INSERT INTO releases_fts(releases_fts, rowid, title, content, content_summary)
  VALUES ('delete', old.rowid, old.title, old.content, old.content_summary);
END;

CREATE TRIGGER IF NOT EXISTS releases_au AFTER UPDATE ON releases BEGIN
  INSERT INTO releases_fts(releases_fts, rowid, title, content, content_summary)
  VALUES ('delete', old.rowid, old.title, old.content, old.content_summary);
  INSERT INTO releases_fts(rowid, title, content, content_summary)
  VALUES (new.rowid, new.title, new.content, new.content_summary);
END;

-- Indexes
CREATE UNIQUE INDEX idx_org_accounts_platform_handle ON org_accounts(platform, handle);
CREATE INDEX idx_sources_org ON sources(org_id);
CREATE INDEX idx_sources_product ON sources(product_id);
CREATE INDEX idx_sources_org_hidden ON sources(org_id, is_hidden);
CREATE UNIQUE INDEX idx_releases_source_url ON releases(source_id, url);
CREATE UNIQUE INDEX idx_releases_source_hash ON releases(source_id, content_hash);
CREATE INDEX idx_releases_source_published ON releases(source_id, published_at);
CREATE INDEX idx_releases_published ON releases(published_at);
CREATE INDEX idx_releases_fetched_at ON releases(fetched_at);
CREATE INDEX idx_releases_source_suppressed_published ON releases(source_id, suppressed, published_at);
CREATE INDEX idx_fetch_log_source ON fetch_log(source_id);
CREATE INDEX idx_fetch_log_created ON fetch_log(created_at);
CREATE UNIQUE INDEX idx_ignored_urls_org_url ON ignored_urls(org_id, url);
CREATE UNIQUE INDEX idx_summaries_unique ON release_summaries(source_id, org_id, type, year, month);
CREATE INDEX idx_summaries_source_type ON release_summaries(source_id, type);
CREATE INDEX idx_summaries_org_type ON release_summaries(org_id, type);
CREATE INDEX idx_media_assets_source ON media_assets(source_id);
CREATE INDEX idx_media_assets_release ON media_assets(release_id);
CREATE INDEX idx_media_assets_hash ON media_assets(content_hash);
CREATE INDEX idx_products_org ON products(org_id);
CREATE INDEX idx_organizations_category ON organizations(category);
CREATE INDEX idx_products_category ON products(category);
CREATE UNIQUE INDEX idx_org_tags_pk ON org_tags(org_id, tag_id);
CREATE INDEX idx_org_tags_tag ON org_tags(tag_id);
CREATE UNIQUE INDEX idx_product_tags_pk ON product_tags(product_id, tag_id);
CREATE INDEX idx_product_tags_tag ON product_tags(tag_id);
