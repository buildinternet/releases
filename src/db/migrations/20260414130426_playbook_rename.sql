-- Rename knowledge_pages scope 'source-guide' → 'playbook'.
-- Data-only migration — local SQLite has no CHECK constraint on scope,
-- so a plain UPDATE is sufficient. The D1 side gets a parallel migration
-- that also rebuilds the CHECK constraint.
UPDATE knowledge_pages SET scope = 'playbook' WHERE scope = 'source-guide';
