-- Per-org "don't feature" flag. Excludes the org from the homepage ticker and
-- the /v1/orgs directory listing while keeping it reachable via detail page,
-- search, and sitemap. The organizations_active / organizations_public SELECT *
-- views expose the new column at query time — no view recreation required.
ALTER TABLE organizations ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;
