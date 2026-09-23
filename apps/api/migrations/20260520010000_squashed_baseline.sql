-- Squashed baseline: full schema captured from prod (released-db) on 2026-05-19.
-- Replaces every migration that landed before this file.
--
-- This file is idempotent: every CREATE uses IF NOT EXISTS so a re-apply
-- against an already-migrated database is a no-op. On prod and staging the
-- baseline is pre-stamped in d1_migrations so wrangler never tries to apply
-- it anyway; the IF NOT EXISTS belt-and-suspenders covers fresh dev DBs that
-- got partway through the old migration timeline.

PRAGMA foreign_keys = OFF;


-- ===== TABLES =====

-- [table] batch_runs
CREATE TABLE IF NOT EXISTS batch_runs (
  id                       TEXT     PRIMARY KEY NOT NULL,
  anthropic_batch_id       TEXT     NOT NULL UNIQUE,
  caller                   TEXT     NOT NULL CHECK (caller IN ('script', 'workflow', 'admin')),
  model                    TEXT     NOT NULL,
  status                   TEXT     NOT NULL CHECK (status IN ('submitted', 'in_progress', 'ended', 'failed')),
  request_count_total      INTEGER  NOT NULL DEFAULT 0 CHECK (request_count_total >= 0),
  request_count_succeeded  INTEGER  NOT NULL DEFAULT 0 CHECK (request_count_succeeded >= 0),
  request_count_errored    INTEGER  NOT NULL DEFAULT 0 CHECK (request_count_errored >= 0),
  request_count_expired    INTEGER  NOT NULL DEFAULT 0 CHECK (request_count_expired >= 0),
  request_count_canceled   INTEGER  NOT NULL DEFAULT 0 CHECK (request_count_canceled >= 0),
  created_at               TEXT     NOT NULL,
  ended_at                 TEXT,
  est_cost_usd             REAL,
  actual_cost_usd          REAL,
  caller_context           TEXT,   
  error_summary            TEXT    
);

-- [table] blocked_urls
CREATE TABLE IF NOT EXISTS blocked_urls (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'exact',
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- [table] categories
CREATE TABLE IF NOT EXISTS categories (
  slug TEXT PRIMARY KEY,
  name TEXT,
  description TEXT,
  updated_at TEXT NOT NULL
, aliases TEXT NOT NULL DEFAULT '[]');

-- [table] collection_members
CREATE TABLE IF NOT EXISTS "collection_members" (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CHECK ((org_id IS NOT NULL) <> (product_id IS NOT NULL))
);

-- [table] collections
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, embedded_at TEXT);

-- [table] cron_runs
CREATE TABLE IF NOT EXISTS `cron_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`cron_name` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`duration_ms` integer,
	`status` text NOT NULL,
	`candidates` integer DEFAULT 0 NOT NULL,
	`dispatched` integer DEFAULT 0 NOT NULL,
	`skipped_over_cap` integer DEFAULT 0 NOT NULL,
	`dispatch_errors` integer DEFAULT 0 NOT NULL,
	`sessions_started` text,
	`dispatch_error_detail` text,
	`abort_reason` text,
	`notes` text
);

-- [table] domain_aliases
CREATE TABLE IF NOT EXISTS domain_aliases (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

-- [table] fetch_log
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
, session_id TEXT, error_category TEXT);

-- [table] ignored_urls
CREATE TABLE IF NOT EXISTS ignored_urls (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  reason TEXT,
  ignored_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- [table] knowledge_page_citations
CREATE TABLE IF NOT EXISTS knowledge_page_citations (
  id TEXT PRIMARY KEY,
  knowledge_page_id TEXT NOT NULL REFERENCES knowledge_pages(id) ON DELETE CASCADE,
  
  start_index INTEGER NOT NULL,
  end_index INTEGER NOT NULL,
  
  
  source_url TEXT NOT NULL,
  
  
  title TEXT,
  
  
  cited_text TEXT NOT NULL,
  
  
  
  
  release_id TEXT REFERENCES releases(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

-- [table] knowledge_pages
CREATE TABLE IF NOT EXISTS "knowledge_pages" (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('org', 'product', 'playbook')),
  org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  notes TEXT,
  release_count INTEGER NOT NULL DEFAULT 0,
  last_contributing_release_at TEXT,
  generated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- [table] media_assets
CREATE TABLE IF NOT EXISTS media_assets (
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

-- [table] org_accounts
CREATE TABLE IF NOT EXISTS org_accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  handle TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- [table] org_tags
CREATE TABLE IF NOT EXISTS org_tags (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

-- [table] organizations
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  domain TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  description TEXT,
  category TEXT
, avatar_url TEXT, embedded_at TEXT, discovery TEXT NOT NULL DEFAULT 'curated', deleted_at TEXT, auto_generate_content INTEGER NOT NULL DEFAULT 0, fetch_paused INTEGER NOT NULL DEFAULT 0);

-- [table] product_tags
CREATE TABLE IF NOT EXISTS product_tags (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

-- [table] products
CREATE TABLE IF NOT EXISTS "products" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url TEXT,
  description TEXT,
  category TEXT,
  created_at TEXT NOT NULL,
  embedded_at TEXT,
  deleted_at TEXT
, kind TEXT);

-- [table] release_coverage
CREATE TABLE IF NOT EXISTS `release_coverage` (
	`coverage_id` text PRIMARY KEY NOT NULL,
	`canonical_id` text NOT NULL,
	`reason` text,
	`decided_by` text NOT NULL,
	`decided_at` text NOT NULL,
	FOREIGN KEY (`coverage_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`canonical_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE cascade
);

-- [table] release_summaries
CREATE TABLE IF NOT EXISTS release_summaries (
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

-- [table] releases
CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  version TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  url TEXT,
  content_hash TEXT,
  metadata TEXT DEFAULT '{}',
  published_at TEXT,
  fetched_at TEXT NOT NULL,
  suppressed INTEGER DEFAULT 0,
  suppressed_reason TEXT,
  media TEXT DEFAULT '[]'
, type TEXT NOT NULL DEFAULT 'feature', embedded_at TEXT, prerelease INTEGER NOT NULL DEFAULT 0, title_generated TEXT, title_short TEXT, version_sort TEXT, content_chars INTEGER, content_tokens INTEGER);

-- [table] releases_fts
CREATE VIRTUAL TABLE IF NOT EXISTS releases_fts USING fts5(
  title,
  summary,
  content,
  content='releases',
  content_rowid='rowid'
);

-- [table] search_queries
CREATE TABLE IF NOT EXISTS search_queries (
  id TEXT PRIMARY KEY NOT NULL,
  timestamp INTEGER NOT NULL,
  surface TEXT NOT NULL,
  client_kind TEXT NOT NULL DEFAULT 'external',
  query TEXT NOT NULL,
  mode TEXT,
  types TEXT,
  organization TEXT,
  entity TEXT,
  org_hits INTEGER,
  catalog_hits INTEGER,
  release_hits INTEGER,
  chunk_hits INTEGER,
  degraded INTEGER,
  duration_ms INTEGER,
  anon_id TEXT,
  session_id TEXT,
  user_agent TEXT
, authed INTEGER, collection_hits INTEGER);

-- [table] source_changelog_chunks
CREATE TABLE IF NOT EXISTS source_changelog_chunks (
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

-- [table] source_changelog_files
CREATE TABLE IF NOT EXISTS source_changelog_files (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL,
  path TEXT NOT NULL,
  filename TEXT NOT NULL,
  url TEXT NOT NULL,
  raw_url TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  fetched_at TEXT NOT NULL, tokens INTEGER,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON UPDATE NO ACTION ON DELETE CASCADE
);

-- [table] sources
CREATE TABLE IF NOT EXISTS "sources" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  type TEXT NOT NULL,
  url TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
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
  is_hidden INTEGER DEFAULT 0,
  change_detected_at TEXT,
  last_polled_at TEXT,
  embedded_at TEXT,
  median_gap_days REAL,
  last_retiered_at TEXT,
  discovery TEXT NOT NULL DEFAULT 'curated',
  deleted_at TEXT
, kind TEXT);

-- [table] tags
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- [table] telemetry_events
CREATE TABLE IF NOT EXISTS telemetry_events (
  id TEXT PRIMARY KEY NOT NULL,
  anon_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  surface TEXT NOT NULL,
  client_kind TEXT NOT NULL DEFAULT 'external',
  session_id TEXT,
  agent_name TEXT,
  model TEXT,
  command TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER,
  cli_version TEXT NOT NULL,
  os TEXT,
  arch TEXT,
  runtime TEXT
);

-- [table] usage_log
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  release_count INTEGER,
  created_at TEXT NOT NULL
, extraction_mode TEXT, tool_rounds INTEGER, tool_chars INTEGER, fallback_reason TEXT, cache_read_tokens INTEGER, cache_write_tokens INTEGER, source_id TEXT REFERENCES sources(id) ON DELETE SET NULL);

-- [table] webhook_subscriptions
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url                   TEXT NOT NULL,
  source_id             TEXT REFERENCES sources(id) ON DELETE CASCADE,
  enabled               INTEGER NOT NULL DEFAULT 1,
  description           TEXT,
  secret_version        INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  last_success_at       TEXT,
  last_error_at         TEXT,
  last_error_msg        TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  disabled_reason       TEXT
);

-- [table] workflow_failures
CREATE TABLE IF NOT EXISTS `workflow_failures` (
  `id` text PRIMARY KEY NOT NULL,
  `scheduled_time` integer NOT NULL,
  `source_id` text NOT NULL,
  `step_name` text NOT NULL,
  `error` text NOT NULL,
  `created_at` text NOT NULL DEFAULT (datetime('now'))
);

-- ===== INDEXS =====

-- [index] idx_batch_runs_anthropic_id
CREATE INDEX IF NOT EXISTS idx_batch_runs_anthropic_id  ON batch_runs (anthropic_batch_id);

-- [index] idx_batch_runs_created_at
CREATE INDEX IF NOT EXISTS idx_batch_runs_created_at    ON batch_runs (created_at);

-- [index] idx_collection_members_org
CREATE INDEX IF NOT EXISTS idx_collection_members_org
  ON collection_members(org_id) WHERE org_id IS NOT NULL;

-- [index] idx_collection_members_org_pk
CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_members_org_pk
  ON collection_members(collection_id, org_id) WHERE org_id IS NOT NULL;

-- [index] idx_collection_members_product
CREATE INDEX IF NOT EXISTS idx_collection_members_product
  ON collection_members(product_id) WHERE product_id IS NOT NULL;

-- [index] idx_collection_members_product_pk
CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_members_product_pk
  ON collection_members(collection_id, product_id) WHERE product_id IS NOT NULL;

-- [index] idx_cron_runs_name_started
CREATE INDEX IF NOT EXISTS `idx_cron_runs_name_started` ON `cron_runs` (`cron_name`,`started_at`);

-- [index] idx_domain_aliases_org
CREATE INDEX IF NOT EXISTS idx_domain_aliases_org ON domain_aliases(org_id);

-- [index] idx_domain_aliases_product
CREATE INDEX IF NOT EXISTS idx_domain_aliases_product ON domain_aliases(product_id);

-- [index] idx_fetch_log_created
CREATE INDEX IF NOT EXISTS idx_fetch_log_created ON fetch_log(created_at);

-- [index] idx_fetch_log_session
CREATE INDEX IF NOT EXISTS idx_fetch_log_session ON fetch_log (session_id);

-- [index] idx_fetch_log_source
CREATE INDEX IF NOT EXISTS idx_fetch_log_source ON fetch_log(source_id);

-- [index] idx_ignored_urls_org_url
CREATE UNIQUE INDEX IF NOT EXISTS idx_ignored_urls_org_url ON ignored_urls(org_id, url);

-- [index] idx_knowledge_page_citations_page
CREATE INDEX IF NOT EXISTS idx_knowledge_page_citations_page
  ON knowledge_page_citations(knowledge_page_id);

-- [index] idx_knowledge_pages_scope
CREATE INDEX IF NOT EXISTS idx_knowledge_pages_scope ON knowledge_pages(scope);

-- [index] idx_knowledge_pages_scope_org
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_pages_scope_org ON knowledge_pages(scope, org_id);

-- [index] idx_knowledge_pages_scope_product
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_pages_scope_product ON knowledge_pages(scope, product_id);

-- [index] idx_media_assets_hash
CREATE INDEX IF NOT EXISTS idx_media_assets_hash ON media_assets(content_hash);

-- [index] idx_media_assets_release
CREATE INDEX IF NOT EXISTS idx_media_assets_release ON media_assets(release_id);

-- [index] idx_media_assets_source
CREATE INDEX IF NOT EXISTS idx_media_assets_source ON media_assets(source_id);

-- [index] idx_org_accounts_platform_handle
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_accounts_platform_handle ON org_accounts(platform, handle);

-- [index] idx_org_tags_pk
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_tags_pk ON org_tags(org_id, tag_id);

-- [index] idx_org_tags_tag
CREATE INDEX IF NOT EXISTS idx_org_tags_tag ON org_tags(tag_id);

-- [index] idx_organizations_category
CREATE INDEX IF NOT EXISTS idx_organizations_category ON organizations(category);

-- [index] idx_organizations_deleted_at
CREATE INDEX IF NOT EXISTS idx_organizations_deleted_at
  ON organizations(deleted_at) WHERE deleted_at IS NOT NULL;

-- [index] idx_organizations_discovery
CREATE INDEX IF NOT EXISTS idx_organizations_discovery ON organizations(discovery);

-- [index] idx_product_tags_pk
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_tags_pk ON product_tags(product_id, tag_id);

-- [index] idx_product_tags_tag
CREATE INDEX IF NOT EXISTS idx_product_tags_tag ON product_tags(tag_id);

-- [index] idx_products_deleted_at
CREATE INDEX IF NOT EXISTS idx_products_deleted_at ON products(deleted_at) WHERE deleted_at IS NOT NULL;

-- [index] idx_products_kind
CREATE INDEX IF NOT EXISTS idx_products_kind ON products(kind) WHERE kind IS NOT NULL;

-- [index] idx_products_org
CREATE INDEX IF NOT EXISTS idx_products_org ON products(org_id);

-- [index] idx_products_org_slug
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_org_slug ON products(org_id, slug);

-- [index] idx_release_coverage_canonical
CREATE INDEX IF NOT EXISTS `idx_release_coverage_canonical` ON `release_coverage` (`canonical_id`);

-- [index] idx_releases_fetched_at
CREATE INDEX IF NOT EXISTS idx_releases_fetched_at ON releases(fetched_at);

-- [index] idx_releases_published
CREATE INDEX IF NOT EXISTS idx_releases_published ON releases(published_at);

-- [index] idx_releases_published_id
CREATE INDEX IF NOT EXISTS idx_releases_published_id ON releases (published_at DESC, id DESC);

-- [index] idx_releases_source_published
CREATE INDEX IF NOT EXISTS idx_releases_source_published ON releases(source_id, published_at);

-- [index] idx_releases_source_suppressed_published
CREATE INDEX IF NOT EXISTS idx_releases_source_suppressed_published ON releases(source_id, suppressed, published_at);

-- [index] idx_releases_source_url
CREATE UNIQUE INDEX IF NOT EXISTS idx_releases_source_url ON releases(source_id, url);

-- [index] idx_releases_source_version_sort
CREATE INDEX IF NOT EXISTS idx_releases_source_version_sort
  ON releases(source_id, version_sort);

-- [index] idx_scc_content_hash
CREATE INDEX IF NOT EXISTS idx_scc_content_hash ON source_changelog_chunks (content_hash);

-- [index] idx_scc_file
CREATE INDEX IF NOT EXISTS idx_scc_file ON source_changelog_chunks (source_changelog_file_id);

-- [index] idx_scc_source
CREATE INDEX IF NOT EXISTS idx_scc_source ON source_changelog_chunks (source_id);

-- [index] idx_scf_source
CREATE INDEX IF NOT EXISTS idx_scf_source ON source_changelog_files (source_id);

-- [index] idx_search_queries_surface_timestamp
CREATE INDEX IF NOT EXISTS idx_search_queries_surface_timestamp ON search_queries (surface, timestamp);

-- [index] idx_search_queries_timestamp
CREATE INDEX IF NOT EXISTS idx_search_queries_timestamp ON search_queries (timestamp);

-- [index] idx_search_queries_timestamp_query
CREATE INDEX IF NOT EXISTS idx_search_queries_timestamp_query ON search_queries (timestamp, query);

-- [index] idx_sources_deleted_at
CREATE INDEX IF NOT EXISTS idx_sources_deleted_at ON sources(deleted_at) WHERE deleted_at IS NOT NULL;

-- [index] idx_sources_discovery
CREATE INDEX IF NOT EXISTS idx_sources_discovery ON sources(discovery);

-- [index] idx_sources_kind
CREATE INDEX IF NOT EXISTS idx_sources_kind ON sources(kind) WHERE kind IS NOT NULL;

-- [index] idx_sources_last_fetched_at
CREATE INDEX IF NOT EXISTS idx_sources_last_fetched_at ON sources(last_fetched_at);

-- [index] idx_sources_median_gap_days
CREATE INDEX IF NOT EXISTS idx_sources_median_gap_days ON sources(median_gap_days);

-- [index] idx_sources_name
CREATE INDEX IF NOT EXISTS idx_sources_name ON sources(name);

-- [index] idx_sources_org
CREATE INDEX IF NOT EXISTS idx_sources_org ON sources(org_id);

-- [index] idx_sources_org_hidden
CREATE INDEX IF NOT EXISTS idx_sources_org_hidden ON sources(org_id, is_hidden);

-- [index] idx_sources_org_slug
CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_org_slug ON sources(org_id, slug);

-- [index] idx_sources_product
CREATE INDEX IF NOT EXISTS idx_sources_product ON sources(product_id);

-- [index] idx_sources_slug
CREATE INDEX IF NOT EXISTS idx_sources_slug ON sources(slug);

-- [index] idx_summaries_org_type
CREATE INDEX IF NOT EXISTS idx_summaries_org_type ON release_summaries(org_id, type);

-- [index] idx_summaries_source_type
CREATE INDEX IF NOT EXISTS idx_summaries_source_type ON release_summaries(source_id, type);

-- [index] idx_summaries_unique
CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_unique ON release_summaries(source_id, org_id, type, year, month);

-- [index] idx_telemetry_anon_timestamp
CREATE INDEX IF NOT EXISTS idx_telemetry_anon_timestamp ON telemetry_events (anon_id, timestamp);

-- [index] idx_telemetry_command_timestamp
CREATE INDEX IF NOT EXISTS idx_telemetry_command_timestamp ON telemetry_events (command, timestamp);

-- [index] idx_telemetry_kind_timestamp
CREATE INDEX IF NOT EXISTS idx_telemetry_kind_timestamp ON telemetry_events (client_kind, timestamp);

-- [index] idx_telemetry_session
CREATE INDEX IF NOT EXISTS idx_telemetry_session ON telemetry_events (session_id);

-- [index] idx_telemetry_timestamp
CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry_events (timestamp);

-- [index] idx_webhook_subs_org_enabled
CREATE INDEX IF NOT EXISTS idx_webhook_subs_org_enabled
  ON webhook_subscriptions (org_id, enabled);

-- [index] idx_webhook_subs_org_source
CREATE INDEX IF NOT EXISTS idx_webhook_subs_org_source
  ON webhook_subscriptions (org_id, source_id);

-- [index] idx_workflow_failures_scheduled
CREATE INDEX IF NOT EXISTS `idx_workflow_failures_scheduled` ON `workflow_failures` (`scheduled_time`);

-- [index] scc_file_offset_uq
CREATE UNIQUE INDEX IF NOT EXISTS scc_file_offset_uq ON source_changelog_chunks (source_changelog_file_id, offset);

-- [index] scf_source_path_uq
CREATE UNIQUE INDEX IF NOT EXISTS scf_source_path_uq ON source_changelog_files (source_id, path);

-- ===== VIEWS =====

-- [view] organizations_active
CREATE VIEW IF NOT EXISTS organizations_active AS
  SELECT * FROM organizations WHERE deleted_at IS NULL;

-- [view] organizations_public
CREATE VIEW IF NOT EXISTS organizations_public AS
  SELECT * FROM organizations_active
  WHERE discovery <> 'on_demand' OR discovery IS NULL;

-- [view] products_active
CREATE VIEW IF NOT EXISTS products_active AS
  SELECT * FROM products WHERE deleted_at IS NULL;

-- [view] releases_visible
CREATE VIEW IF NOT EXISTS releases_visible AS
  SELECT releases.*
  FROM releases
  WHERE (releases.suppressed IS NULL OR releases.suppressed = 0)
    AND NOT EXISTS (
      SELECT 1 FROM release_coverage
      WHERE release_coverage.coverage_id = releases.id
    );

-- [view] sources_active
CREATE VIEW IF NOT EXISTS sources_active AS
  SELECT * FROM sources WHERE deleted_at IS NULL;

-- [view] sources_visible
CREATE VIEW IF NOT EXISTS sources_visible AS
  SELECT * FROM sources_active WHERE is_hidden = 0;

-- ===== TRIGGERS =====

-- [trigger] releases_ad
CREATE TRIGGER IF NOT EXISTS releases_ad AFTER DELETE ON releases BEGIN
  INSERT INTO releases_fts(releases_fts, rowid, title, summary, content)
  VALUES ('delete', old.rowid, old.title, old.summary, old.content);
END;

-- [trigger] releases_ai
CREATE TRIGGER IF NOT EXISTS releases_ai AFTER INSERT ON releases BEGIN
  INSERT INTO releases_fts(rowid, title, summary, content)
  VALUES (new.rowid, new.title, new.summary, new.content);
END;

-- [trigger] releases_au
CREATE TRIGGER IF NOT EXISTS releases_au AFTER UPDATE ON releases BEGIN
  INSERT INTO releases_fts(releases_fts, rowid, title, summary, content)
  VALUES ('delete', old.rowid, old.title, old.summary, old.content);
  INSERT INTO releases_fts(rowid, title, summary, content)
  VALUES (new.rowid, new.title, new.summary, new.content);
END;

PRAGMA foreign_keys = ON;
