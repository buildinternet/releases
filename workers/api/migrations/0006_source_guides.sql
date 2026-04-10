-- Allow multiple knowledge page types per org/product by making unique indexes composite with scope.
-- This enables "source-guide" pages alongside existing "org"/"product" overview pages.
-- Also updates the CHECK constraint to allow the new scope value.

-- Drop old unique indexes
DROP INDEX IF EXISTS idx_knowledge_pages_org;
DROP INDEX IF EXISTS idx_knowledge_pages_product;

-- Recreate table to update CHECK constraint (SQLite cannot ALTER CHECK constraints)
CREATE TABLE knowledge_pages_new (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('org', 'product', 'source-guide')),
  org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  release_count INTEGER NOT NULL DEFAULT 0,
  last_contributing_release_at TEXT,
  generated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO knowledge_pages_new SELECT * FROM knowledge_pages;
DROP TABLE knowledge_pages;
ALTER TABLE knowledge_pages_new RENAME TO knowledge_pages;

-- Recreate indexes as composite (scope + id)
CREATE UNIQUE INDEX idx_knowledge_pages_scope_org ON knowledge_pages(scope, org_id);
CREATE UNIQUE INDEX idx_knowledge_pages_scope_product ON knowledge_pages(scope, product_id);
CREATE INDEX idx_knowledge_pages_scope ON knowledge_pages(scope);
