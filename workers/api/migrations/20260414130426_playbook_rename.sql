-- Rename knowledge_pages scope 'source-guide' → 'playbook'.
-- The D1 table has a CHECK constraint on scope that must be rebuilt
-- because SQLite cannot ALTER CHECK constraints — so we recreate the
-- table and flip the scope value in the copy step.

DROP INDEX IF EXISTS idx_knowledge_pages_scope_org;
DROP INDEX IF EXISTS idx_knowledge_pages_scope_product;
DROP INDEX IF EXISTS idx_knowledge_pages_scope;

CREATE TABLE knowledge_pages_new (
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

INSERT INTO knowledge_pages_new (id, scope, org_id, product_id, content, notes, release_count, last_contributing_release_at, generated_at, updated_at)
SELECT id,
       CASE WHEN scope = 'source-guide' THEN 'playbook' ELSE scope END AS scope,
       org_id, product_id, content, notes, release_count, last_contributing_release_at, generated_at, updated_at
FROM knowledge_pages;

DROP TABLE knowledge_pages;
ALTER TABLE knowledge_pages_new RENAME TO knowledge_pages;

CREATE UNIQUE INDEX idx_knowledge_pages_scope_org ON knowledge_pages(scope, org_id);
CREATE UNIQUE INDEX idx_knowledge_pages_scope_product ON knowledge_pages(scope, product_id);
CREATE INDEX idx_knowledge_pages_scope ON knowledge_pages(scope);
