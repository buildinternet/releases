-- Add category column to organizations
ALTER TABLE organizations ADD COLUMN category TEXT;

-- Add category column to products
ALTER TABLE products ADD COLUMN category TEXT;

-- Category indexes for filter queries
CREATE INDEX idx_organizations_category ON organizations(category);
CREATE INDEX idx_products_category ON products(category);

-- Tags table
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- Org-tag join table
CREATE TABLE org_tags (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_org_tags_pk ON org_tags(org_id, tag_id);
CREATE INDEX idx_org_tags_tag ON org_tags(tag_id);

-- Product-tag join table
CREATE TABLE product_tags (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_product_tags_pk ON product_tags(product_id, tag_id);
CREATE INDEX idx_product_tags_tag ON product_tags(tag_id);
