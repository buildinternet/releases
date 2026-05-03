-- #699 Phase D step 1: add source_id to usage_log for per-org slug disambiguation.
--
-- source_slug is ambiguous now that sources.slug is only unique per-org (#690).
-- This column lets read paths group by the stable FK instead of the mutable slug.
-- source_slug is kept for the dual-write period and will be dropped in a follow-up
-- table rebuild (DROP COLUMN requires SQLite ALTER TABLE rebuild on older versions).
ALTER TABLE usage_log ADD COLUMN source_id TEXT REFERENCES sources(id) ON DELETE CASCADE;
