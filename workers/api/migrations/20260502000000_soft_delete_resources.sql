-- Soft-delete the four heavy resource endpoints (issue #666).
--
-- Adds nullable deleted_at to organizations, sources, products. The releases
-- case stays on the existing releases.suppressed flag — every read path
-- already filters via notSuppressed, and the URL upsert path naturally
-- overwrites suppressed rows on re-fetch.
--
-- Slug uniqueness: the column-level UNIQUE on slug is intentionally kept.
-- D1 does not honor `PRAGMA foreign_keys = OFF` inside its implicit migration
-- transaction, so a CREATE-INSERT-DROP-RENAME rebuild of a heavily-referenced
-- parent (organizations, sources) hits SQLITE_LOCKED. Instead, the route
-- handlers rename the slug on tombstone (slug --deleted-<id>) so a re-onboard
-- under the original slug just works without colliding with the tombstone.
-- See workers/api/src/routes/{orgs,sources,products}.ts.

ALTER TABLE organizations ADD COLUMN deleted_at TEXT;
ALTER TABLE sources       ADD COLUMN deleted_at TEXT;
ALTER TABLE products      ADD COLUMN deleted_at TEXT;
