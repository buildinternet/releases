-- Phase A of #690 — per-org uniqueness for source/product slugs.
--
-- Today both `sources.slug` and `products.slug` carry a global UNIQUE
-- constraint (declared inline on the column in baseline.sql). The end state
-- is `(org_id, slug)` UNIQUE so that two unrelated orgs can each ship a
-- `cli` source without colliding. The cutover migration in Phase C drops
-- the global UNIQUE and tightens `sources.org_id` to NOT NULL + CASCADE.
--
-- This migration is purely additive: we add `(org_id, slug)` UNIQUE
-- alongside the existing global UNIQUE. Two effects:
--
--   1. If any current row has a NULL org_id (orphan), the index creation
--      will succeed — SQLite treats NULLs as distinct in unique indexes.
--      We've already adopted the lone prod orphan (Nuxt) into an org as
--      a precondition; this is the safety net if a new orphan slips in.
--
--   2. Because slugs are globally unique today, `(org_id, slug)` is also
--      unique by construction. The CREATE statements below should never
--      fail on existing data; if they do, that's a signal a pre-Phase-A
--      collision was inserted (e.g. via direct DB write) and needs human
--      resolution before Phase C can land.
--
-- Tombstoned rows mangle their slug to `<slug>--<id>` (see sources.ts and
-- products.ts soft-delete handlers), which keeps the suffix unique even
-- across orgs. No partial predicate needed.

CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_org_slug
  ON sources(org_id, slug);

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_org_slug
  ON products(org_id, slug);
