-- Stub-tier epic phase 1 (#1947).
--
-- 1. organizations.tier — gates fetching/processing + SEO posture. `stub` = an
--    org known only by declared release locations (no sources, nothing
--    schedulable, noindex + out of sitemap); `tracked` = a normal org. Default
--    `tracked` so every existing org is unaffected. The organizations_active /
--    organizations_public views are `SELECT *`, so they expose the new column
--    at query time — no view recreation required.
ALTER TABLE organizations
  ADD COLUMN tier TEXT NOT NULL DEFAULT 'tracked' CHECK (tier IN ('stub', 'tracked'));

-- 2. release_locations — the declared-locator store. Columns mirror the
--    releases.json v2 ReleaseLocationFields verbatim (url/feed/github/appstore/
--    file/title/canonical) plus provenance (basis/evidence) and promotion
--    linkage (source_id). A stub org holds locator rows and no source rows;
--    promotion materializes these into sources and stamps source_id.
CREATE TABLE release_locations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  url TEXT,
  feed TEXT,
  github TEXT,
  appstore TEXT,
  file TEXT,
  title TEXT,
  canonical INTEGER NOT NULL DEFAULT 0,
  basis TEXT NOT NULL CHECK (basis IN ('curator', 'declared', 'detected', 'generated')),
  evidence TEXT,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  match_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CONSTRAINT release_locations_has_locator
    CHECK (url IS NOT NULL OR feed IS NOT NULL OR github IS NOT NULL OR appstore IS NOT NULL OR file IS NOT NULL)
);

-- Partial over soft-delete so a tombstoned locator never blocks a later
-- re-declaration of the same (org_id, match_key). Writers upsert with
-- ON CONFLICT(org_id, match_key) WHERE deleted_at IS NULL.
CREATE UNIQUE INDEX idx_release_locations_org_match ON release_locations (org_id, match_key) WHERE deleted_at IS NULL;
CREATE INDEX idx_release_locations_org ON release_locations (org_id);
CREATE INDEX idx_release_locations_product ON release_locations (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX idx_release_locations_source ON release_locations (source_id) WHERE source_id IS NOT NULL;
CREATE INDEX idx_release_locations_deleted_at ON release_locations (deleted_at) WHERE deleted_at IS NOT NULL;
