-- Issue #674: collapse `notDisabled` into a sources_visible view.
--
-- Follow-up to #671. After landing the *_active views, every public read
-- site that wants to hide on-demand / hidden sources still had to apply
-- `notDisabled = (is_hidden = 0 OR is_hidden IS NULL)` by hand — same
-- brittle-by-default story we just collapsed for tombstones.
--
-- This view layers on top of sources_active so both the soft-delete and
-- not-hidden predicates live in one place. Read paths flip from
-- `sourcesActive` → `sourcesVisible` wherever they previously combined
-- the soft-delete filter with `notDisabled`. Write paths and admin
-- routes that *want* to see hidden sources keep using the base table or
-- `sources_active`.
--
-- The view is non-materialized; SQLite's planner inlines both predicates
-- so existing indexes on `sources` (slug, org_id, fetch tier columns)
-- remain effective.

CREATE VIEW IF NOT EXISTS sources_visible AS
  SELECT * FROM sources_active WHERE is_hidden = 0;
