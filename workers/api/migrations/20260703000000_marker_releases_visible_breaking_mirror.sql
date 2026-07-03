-- Marker migration (no DDL) — pairs with the packages/core/src/schema.ts edit
-- that adds `breaking` to the `releasesVisible` drizzle VIEW MIRROR (#1710).
-- No database change is needed: `releases_visible` is `SELECT releases.*`, so
-- SQLite already exposes the `breaking` column added by
-- 20260620000000_add_release_breaking.sql through the view. This file exists
-- only to satisfy the CI schema-change/migration pairing gate.
SELECT 1;
