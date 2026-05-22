-- Per-collection "promote on the homepage" flag. When set, the collection
-- appears in the home page's featured-collections sidebar block. Toggle via
-- PATCH /v1/collections/:slug { isFeatured: true }. Default 0 (not featured).
-- Mirrors organizations.is_hidden. The initial featured set is seeded out of
-- band via a direct UPDATE (not a migration row) so curation isn't pinned to
-- the schema history.
ALTER TABLE collections ADD COLUMN is_featured INTEGER NOT NULL DEFAULT 0;
