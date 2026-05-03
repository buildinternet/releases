-- Phase A of #690 — per-org uniqueness for source/product slugs.
--
-- Adds `(org_id, slug)` UNIQUE alongside the existing global UNIQUE on slug.
-- Phase C drops the global one. Safe on current data: slugs are globally
-- unique today, so `(org_id, slug)` is unique by construction. NULL org_id
-- rows are fine — SQLite treats NULLs as distinct in unique indexes.
--
-- Tombstoned slugs are mangled to `<slug>--<id>`, so no partial predicate needed.

CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_org_slug
  ON sources(org_id, slug);

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_org_slug
  ON products(org_id, slug);
