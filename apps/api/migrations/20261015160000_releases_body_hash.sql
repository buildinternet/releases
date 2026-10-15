-- Normalized body hash for same-source / same-day reworded-duplicate
-- detection. Nullable: existing rows are hashed from `content` on read until
-- a later write fills the column. Not unique — a backport or release
-- candidate may share a body with the canonical row and stays its own row,
-- linked through release_coverage.
ALTER TABLE releases ADD COLUMN body_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_releases_source_body_hash ON releases (source_id, body_hash);
