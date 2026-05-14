-- Track ENTITIES_INDEX embedding state for collections so the backfill CLI
-- can sweep rows where the side-effect upsert failed (transient Vectorize
-- error, missing binding, etc.). NULL on every existing row; the backfill
-- run after deploy fills in the timestamps.
ALTER TABLE collections ADD COLUMN embedded_at TEXT;
