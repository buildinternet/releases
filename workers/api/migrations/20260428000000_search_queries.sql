CREATE TABLE search_queries (
  id TEXT PRIMARY KEY NOT NULL,
  timestamp INTEGER NOT NULL,
  surface TEXT NOT NULL,
  client_kind TEXT NOT NULL DEFAULT 'external',
  query TEXT NOT NULL,
  mode TEXT,
  types TEXT,
  organization TEXT,
  entity TEXT,
  org_hits INTEGER,
  catalog_hits INTEGER,
  release_hits INTEGER,
  chunk_hits INTEGER,
  degraded INTEGER,
  duration_ms INTEGER,
  anon_id TEXT,
  session_id TEXT,
  user_agent TEXT
);

CREATE INDEX idx_search_queries_timestamp ON search_queries (timestamp);
CREATE INDEX idx_search_queries_surface_timestamp ON search_queries (surface, timestamp);
CREATE INDEX idx_search_queries_timestamp_query ON search_queries (timestamp, query);
