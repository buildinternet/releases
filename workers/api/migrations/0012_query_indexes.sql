-- Compound index for release queries that filter on suppression + date
-- Nearly every release read query filters on (source_id, suppressed, published_at)
CREATE INDEX IF NOT EXISTS idx_releases_source_suppressed_published
  ON releases(source_id, suppressed, published_at);

-- Index for source queries filtered by org + hidden status
CREATE INDEX IF NOT EXISTS idx_sources_org_hidden
  ON sources(org_id, is_hidden);

-- Index for release queries ordered by fetched_at (media backfill, version fallback)
CREATE INDEX IF NOT EXISTS idx_releases_fetched_at
  ON releases(fetched_at);
