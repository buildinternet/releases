-- #1696: structured breaking-change + migration-notes fields on releases.
-- Additive, fail-open: `breaking` defaults to 'unknown' for every existing row
-- (never a false verdict); `migration_notes` is null until the body explicitly
-- describes upgrade steps. New ingests of developer-facing source kinds are
-- classified live; history stays 'unknown' (no backfill — deferred, #1696).
ALTER TABLE releases ADD COLUMN breaking TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE releases ADD COLUMN migration_notes TEXT;
