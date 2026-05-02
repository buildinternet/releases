-- Issue #671: default read paths to filtered views.
--
-- Tombstones are added to organizations/sources/products via deleted_at
-- (#666). Up to now every read path had to remember to filter on
-- `deleted_at IS NULL` (or an alias) — ~92 occurrences across ~21 files,
-- and #669 shipped with several missed sites that CodeRabbit caught.
--
-- These views wrap the bases with the tombstone filter so the type system
-- enforces the safe default: read code imports `organizationsActive` /
-- `productsActive` / `sourcesActive`; only admin DELETE/restore code and
-- the nightly sweep cron reach the base tables.
--
-- Views are non-materialized; SQLite's planner inlines the predicate, so
-- query plans match the explicit-filter form. Existing per-column indexes
-- (slug, org_id, etc.) remain effective.

CREATE VIEW IF NOT EXISTS organizations_active AS
  SELECT * FROM organizations WHERE deleted_at IS NULL;

CREATE VIEW IF NOT EXISTS products_active AS
  SELECT * FROM products WHERE deleted_at IS NULL;

CREATE VIEW IF NOT EXISTS sources_active AS
  SELECT * FROM sources WHERE deleted_at IS NULL;
