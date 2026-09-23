-- Entity notices: a notice is a JSON sub-object stored under the `notice` key
-- of each entity's `metadata` column. organizations/sources/releases already
-- have a metadata column; products did not. products_active is `SELECT *`,
-- which SQLite freezes at view-create time, so the view is dropped and
-- recreated to re-expand the column list and surface metadata.
ALTER TABLE products ADD COLUMN metadata TEXT DEFAULT '{}';

DROP VIEW IF EXISTS products_active;
CREATE VIEW IF NOT EXISTS products_active AS
  SELECT * FROM products WHERE deleted_at IS NULL;
