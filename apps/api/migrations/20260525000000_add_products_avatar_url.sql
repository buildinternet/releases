-- Product app icon (#appstore). Mirrors organizations.avatar_url. Nullable;
-- pointer column (CDN URL or our R2 key). products_active is `SELECT *`, which
-- SQLite freezes at view-create time, so the view is recreated to re-expand
-- the column list and surface avatar_url through the active view.
ALTER TABLE products ADD COLUMN avatar_url TEXT;

DROP VIEW IF EXISTS products_active;
CREATE VIEW IF NOT EXISTS products_active AS
  SELECT * FROM products WHERE deleted_at IS NULL;
