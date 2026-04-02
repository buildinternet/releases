-- Create products table
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url TEXT,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_products_org ON products(org_id);

-- Add product_id to sources
ALTER TABLE sources ADD COLUMN product_id TEXT REFERENCES products(id) ON DELETE SET NULL;
CREATE INDEX idx_sources_product ON sources(product_id);
