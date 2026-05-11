-- Add an alias overlay onto the categories metadata table. JSON array of
-- alternative slugs that redirect to this canonical row (e.g. "e-commerce"
-- → "commerce"); uniqueness across rows is enforced at the API layer, not
-- in SQL.
ALTER TABLE categories ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]';
