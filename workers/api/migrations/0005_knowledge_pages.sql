CREATE TABLE knowledge_pages (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('org', 'product')),
  org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  release_count INTEGER NOT NULL DEFAULT 0,
  last_contributing_release_at TEXT,
  generated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_knowledge_pages_org ON knowledge_pages(org_id);
CREATE UNIQUE INDEX idx_knowledge_pages_product ON knowledge_pages(product_id);
CREATE INDEX idx_knowledge_pages_scope ON knowledge_pages(scope);
