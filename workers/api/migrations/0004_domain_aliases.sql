CREATE TABLE domain_aliases (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_domain_aliases_org ON domain_aliases(org_id);
CREATE INDEX idx_domain_aliases_product ON domain_aliases(product_id);
