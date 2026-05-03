-- #690 Phase C: drop the global slug UNIQUE on `sources` and `products`,
-- flip `sources.org_id` to NOT NULL with ON DELETE CASCADE.
--
-- This is the one-time table-rebuild that the migration system can't apply.
-- The `wrangler d1 migrations apply` flow wraps each file in an implicit
-- transaction in which `PRAGMA foreign_keys = OFF` is a no-op, so dropping
-- a heavily-referenced parent (sources is referenced by releases, fetch_log,
-- source_changelog_files, source_changelog_chunks, release_summaries,
-- media_assets, webhook_subscriptions, …) hits SQLITE_LOCKED. Empirically
-- verified on staging 2026-05-03.
--
-- `wrangler d1 execute --file=` does NOT wrap in the same transaction model,
-- so PRAGMA foreign_keys = OFF takes effect and the rebuild succeeds. Run
-- this file via:
--
--   # Staging (already applied 2026-05-03 — runbook for next reset only):
--   bunx wrangler d1 execute DB --env staging --remote \
--     --config workers/api/wrangler.jsonc \
--     --file=scripts/migrations/690-phase-c-rebuild.sql
--
--   # Prod:
--   bunx wrangler d1 execute released-db --remote \
--     --config workers/api/wrangler.jsonc \
--     --file=scripts/migrations/690-phase-c-rebuild.sql
--
-- After running on prod, INSERT OR IGNORE into d1_migrations under the same
-- name as the companion drizzle migration so the deploy workflow skips it.
--
-- Preconditions (verified on prod 2026-05-03):
--   * 0 sources with NULL org_id
--   * 0 cross-org slug collisions on sources
--   * 0 cross-org slug collisions on products
--
-- Wrangler reverts on partial failure (transactional file execution), so a
-- failed run leaves the DB in its pre-rebuild state and is safe to retry.

PRAGMA foreign_keys = OFF;

-- Views referencing sources have to be dropped first; recreated at the end.
DROP VIEW IF EXISTS sources_visible;
DROP VIEW IF EXISTS sources_active;

CREATE TABLE sources_new (
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
);

INSERT INTO sources_new (
  id, name, slug, type, url, org_id, product_id, metadata, created_at,
  last_fetched_at, last_content_hash, fetch_priority,
  consecutive_no_change, consecutive_errors, next_fetch_after,
  is_primary, is_hidden, change_detected_at, last_polled_at,
  embedded_at, median_gap_days, last_retiered_at, discovery, deleted_at
)
SELECT
  id, name, slug, type, url, org_id, product_id, metadata, created_at,
  last_fetched_at, last_content_hash, fetch_priority,
  consecutive_no_change, consecutive_errors, next_fetch_after,
  is_primary, is_hidden, change_detected_at, last_polled_at,
  embedded_at, median_gap_days, last_retiered_at, discovery, deleted_at
FROM sources
WHERE org_id IS NOT NULL;

DROP TABLE sources;
ALTER TABLE sources_new RENAME TO sources;

CREATE INDEX idx_sources_org ON sources(org_id);
CREATE INDEX idx_sources_org_hidden ON sources(org_id, is_hidden);
CREATE INDEX idx_sources_product ON sources(product_id);
CREATE UNIQUE INDEX idx_sources_org_slug ON sources(org_id, slug);
CREATE INDEX idx_sources_name ON sources(name);
CREATE INDEX idx_sources_last_fetched_at ON sources(last_fetched_at);
CREATE INDEX idx_sources_median_gap_days ON sources(median_gap_days);
CREATE INDEX idx_sources_deleted_at ON sources(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_sources_discovery ON sources(discovery);

CREATE VIEW sources_active AS
  SELECT * FROM sources WHERE deleted_at IS NULL;

CREATE VIEW sources_visible AS
  SELECT * FROM sources_active WHERE is_hidden = 0;

-- Products: same shape as the sources rebuild above but slug-only — org_id
-- was already NOT NULL + cascade. The Phase A (org_id, slug) UNIQUE INDEX
-- becomes the canonical key once the global UNIQUE(slug) is gone.

DROP VIEW IF EXISTS products_active;

CREATE TABLE products_new (
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
);

INSERT INTO products_new (
  id, name, slug, org_id, url, description, category, created_at,
  embedded_at, deleted_at
)
SELECT
  id, name, slug, org_id, url, description, category, created_at,
  embedded_at, deleted_at
FROM products;

DROP TABLE products;
ALTER TABLE products_new RENAME TO products;

CREATE INDEX idx_products_org ON products(org_id);
CREATE UNIQUE INDEX idx_products_org_slug ON products(org_id, slug);
CREATE INDEX idx_products_deleted_at ON products(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE VIEW products_active AS
  SELECT * FROM products WHERE deleted_at IS NULL;

PRAGMA foreign_keys = ON;
