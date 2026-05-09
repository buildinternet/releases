-- Recreates organizations_active and organizations_public so the new
-- `auto_generate_content` column (added in
-- 20260509000200_organizations_auto_generate_content.sql) is exposed
-- through both views.
--
-- SQLite snapshots `SELECT *` view column lists at view-create time, so
-- adding a column to the base `organizations` table does not propagate
-- into existing views automatically. Drop + recreate is the cheap fix;
-- the views are non-materialized and rebuild instantly.
--
-- Keep this migration aligned with packages/core/src/schema.ts: the
-- Drizzle view declarations enumerate columns explicitly, so the typed
-- view shape there must include `auto_generate_content` too.

DROP VIEW IF EXISTS organizations_public;
DROP VIEW IF EXISTS organizations_active;

CREATE VIEW organizations_active AS
  SELECT * FROM organizations WHERE deleted_at IS NULL;

CREATE VIEW organizations_public AS
  SELECT * FROM organizations_active
  WHERE discovery <> 'on_demand' OR discovery IS NULL;
