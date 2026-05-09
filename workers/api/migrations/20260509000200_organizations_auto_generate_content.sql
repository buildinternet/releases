-- Adds the `auto_generate_content` opt-in flag on organizations.
--
-- When 1, the ingest pipeline summarizes new releases inline (Haiku 4.5)
-- and writes content_title / content_title_short / content_summary as
-- part of the workflow step that inserted the row. When 0 (default),
-- those columns stay NULL and read paths fall back to release.title /
-- release.version cleanly.
--
-- Default 0 means every existing org is opted out. Toggle in via direct
-- SQL UPDATE for the initial roster (Anthropic + a small handful);
-- promote to an admin endpoint once the column is read by an admin UI.
--
-- The base column is what the workflow step reads (joined from releases
-- via org_id), so the organizations_active / organizations_public views
-- do not need to be recreated — admin reads through the views won't see
-- the column, but no read path needs that today.

ALTER TABLE organizations ADD COLUMN auto_generate_content INTEGER NOT NULL DEFAULT 0;
