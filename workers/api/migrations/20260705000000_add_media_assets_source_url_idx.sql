-- Fetch-skip dedup for ingest-time R2 mirroring (#1177): resolve an already-
-- mirrored media asset by its third-party source URL so `processMediaForR2` can
-- reuse the existing `r2_key` without re-downloading. Content-hash keying already
-- dedups R2 *storage* (identical bytes -> identical key); this dedups the *fetch*
-- for URLs repeated across releases (feeds carry the same image on every entry;
-- app-store sources across versions). Measured ~5x dup on feed sources.
CREATE INDEX IF NOT EXISTS idx_media_assets_source_url ON media_assets (source_url);
