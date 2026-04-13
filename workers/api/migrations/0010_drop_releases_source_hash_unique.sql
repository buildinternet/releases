-- Drop the UNIQUE(source_id, content_hash) index on releases.
--
-- The batch upsert handler only resolves conflicts on (source_id, url), so any
-- re-fetch that produces an identical content_hash with a drifted URL raised
-- "UNIQUE constraint failed: releases.source_id, releases.content_hash" and
-- surfaced as a generic 500 from POST /v1/sources/:slug/releases/batch.
-- URL-based upsert is the primary dedup path; no reader queries releases by
-- content_hash, so the index is dead weight.
DROP INDEX IF EXISTS idx_releases_source_hash;
