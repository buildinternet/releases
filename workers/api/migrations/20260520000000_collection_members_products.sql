-- Extend collection_members so a collection can pin a single product (not just
-- the whole owning org). Lets a "coding agents" collection include Claude Code
-- without dragging the rest of Anthropic's products in.
--
-- SQLite can't relax the NOT NULL on org_id or add a CHECK in place — rebuild
-- the table.

CREATE TABLE collection_members_new (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CHECK ((org_id IS NOT NULL) <> (product_id IS NOT NULL))
);

INSERT INTO collection_members_new (collection_id, org_id, product_id, position, created_at)
SELECT collection_id, org_id, NULL, position, created_at FROM collection_members;

DROP TABLE collection_members;
ALTER TABLE collection_members_new RENAME TO collection_members;

-- Partial unique indexes keep dedup symmetric across both kinds without
-- forcing both columns to participate in the same UNIQUE.
CREATE UNIQUE INDEX idx_collection_members_org_pk
  ON collection_members(collection_id, org_id) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX idx_collection_members_product_pk
  ON collection_members(collection_id, product_id) WHERE product_id IS NOT NULL;

CREATE INDEX idx_collection_members_org
  ON collection_members(org_id) WHERE org_id IS NOT NULL;
CREATE INDEX idx_collection_members_product
  ON collection_members(product_id) WHERE product_id IS NOT NULL;
