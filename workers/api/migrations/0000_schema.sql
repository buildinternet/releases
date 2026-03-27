-- 0000_schema.sql
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  domain TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS org_accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  handle TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_accounts_platform_handle ON org_accounts(platform, handle);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  url TEXT NOT NULL,
  org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  last_fetched_at TEXT,
  last_content_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_sources_org ON sources(org_id);

CREATE TABLE IF NOT EXISTS releases (
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
  fetched_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_releases_source_url ON releases(source_id, url);
CREATE UNIQUE INDEX IF NOT EXISTS idx_releases_source_hash ON releases(source_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_releases_source_published ON releases(source_id, published_at);
CREATE INDEX IF NOT EXISTS idx_releases_published ON releases(published_at);

CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  source_slug TEXT,
  release_count INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fetch_log (
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
CREATE INDEX IF NOT EXISTS idx_fetch_log_source ON fetch_log(source_id);
CREATE INDEX IF NOT EXISTS idx_fetch_log_created ON fetch_log(created_at);

CREATE TABLE IF NOT EXISTS ignored_urls (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  reason TEXT,
  ignored_at TEXT NOT NULL
);
