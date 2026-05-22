-- Per-collection "promote on the homepage" flag. When set, the collection
-- appears in the home page's featured-collections sidebar block. Toggle via
-- PATCH /v1/collections/:slug { isFeatured: true }. Default 0 (not featured).
-- A plain boolean flag like organizations.is_hidden, but with no backing view
-- or index — it's queried directly via WHERE c.is_featured = 1. The initial
-- featured set is seeded out of band via a direct UPDATE (not a migration row)
-- so curation isn't pinned to the schema history.
ALTER TABLE collections ADD COLUMN is_featured INTEGER NOT NULL DEFAULT 0;
