-- Curated, named groups of orgs that drive a public "playlist" page
-- (e.g. /collections/frontier-ai-labs). Independent of the fixed `category`
-- column on `organizations` so a collection can mix orgs across categories
-- or surface a tighter subset than any single category covers.
CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE collection_members (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Authoring order; ties resolve by org name in the handler.
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_collection_members_pk
  ON collection_members(collection_id, org_id);
CREATE INDEX idx_collection_members_org
  ON collection_members(org_id);
