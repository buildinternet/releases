-- Soft-delete the four heavy resource endpoints (issue #666).
--
-- Adds nullable deleted_at to organizations, sources, products. Drops the
-- column-level UNIQUE(slug)/UNIQUE(domain) constraints and replaces them with
-- partial unique indexes that exclude tombstoned rows. This lets a soft-deleted
-- org/source/product be re-onboarded under the same slug without a collision.
--
-- The releases case stays on the existing releases.suppressed flag — every
-- read path already filters via notSuppressed, and the URL upsert path
-- naturally overwrites suppressed rows on re-fetch.
--
-- Foreign keys must be off during the parent-table rebuilds: with FK=ON, DROP
-- TABLE organizations triggers an implicit cascading DELETE on every child row
-- that references it, which would wipe the data we're trying to preserve.

PRAGMA foreign_keys = OFF;

ALTER TABLE organizations ADD COLUMN deleted_at TEXT;
ALTER TABLE sources       ADD COLUMN deleted_at TEXT;
ALTER TABLE products      ADD COLUMN deleted_at TEXT;

-- ── organizations ──
CREATE TABLE organizations_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  domain TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  description TEXT,
  category TEXT,
  avatar_url TEXT,
  embedded_at TEXT,
  discovery TEXT NOT NULL DEFAULT 'curated',
  deleted_at TEXT
);
INSERT INTO organizations_new (
  id, name, slug, domain, created_at, updated_at, metadata, description,
  category, avatar_url, embedded_at, discovery, deleted_at
) SELECT
  id, name, slug, domain, created_at, updated_at, metadata, description,
  category, avatar_url, embedded_at, discovery, deleted_at
FROM organizations;
DROP TABLE organizations;
ALTER TABLE organizations_new RENAME TO organizations;

-- ── products ──
CREATE TABLE products_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url TEXT,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  category TEXT,
  embedded_at TEXT,
  deleted_at TEXT
);
INSERT INTO products_new (
  id, name, slug, org_id, url, description, created_at, category,
  embedded_at, deleted_at
) SELECT
  id, name, slug, org_id, url, description, created_at, category,
  embedded_at, deleted_at
FROM products;
DROP TABLE products;
ALTER TABLE products_new RENAME TO products;
CREATE INDEX idx_products_org ON products(org_id);

-- ── sources ──
CREATE TABLE sources_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
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
  last_fetched_at, last_content_hash, fetch_priority, consecutive_no_change,
  consecutive_errors, next_fetch_after, is_primary, is_hidden,
  change_detected_at, last_polled_at, embedded_at, median_gap_days,
  last_retiered_at, discovery, deleted_at
) SELECT
  id, name, slug, type, url, org_id, product_id, metadata, created_at,
  last_fetched_at, last_content_hash, fetch_priority, consecutive_no_change,
  consecutive_errors, next_fetch_after, is_primary, is_hidden,
  change_detected_at, last_polled_at, embedded_at, median_gap_days,
  last_retiered_at, discovery, deleted_at
FROM sources;
DROP TABLE sources;
ALTER TABLE sources_new RENAME TO sources;
CREATE INDEX idx_sources_org              ON sources(org_id);
CREATE INDEX idx_sources_org_hidden       ON sources(org_id, is_hidden);
CREATE INDEX idx_sources_product          ON sources(product_id);
CREATE INDEX idx_sources_name             ON sources(name);
CREATE INDEX idx_sources_last_fetched_at  ON sources(last_fetched_at);
CREATE INDEX idx_sources_median_gap_days  ON sources(median_gap_days);

-- ── partial unique indexes (the whole point of this migration) ──
CREATE UNIQUE INDEX idx_organizations_slug_active
  ON organizations(slug) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_organizations_domain_active
  ON organizations(domain) WHERE deleted_at IS NULL AND domain IS NOT NULL;
CREATE UNIQUE INDEX idx_products_slug_active
  ON products(slug) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_sources_slug_active
  ON sources(slug) WHERE deleted_at IS NULL;

PRAGMA foreign_key_check;
PRAGMA foreign_keys = ON;
