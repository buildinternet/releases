-- Editable metadata overlay for the fixed `CATEGORIES` taxonomy in
-- @buildinternet/releases-core/categories. Slug stays the canonical reference
-- on organizations.category / products.category; a row here only exists when
-- an operator has customized the byline. Missing row → API falls back to
-- categoryDisplayName(slug) for `name` and null for `description`.
CREATE TABLE categories (
  slug TEXT PRIMARY KEY,
  name TEXT,
  description TEXT,
  updated_at TEXT NOT NULL
);
