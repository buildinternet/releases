-- Generic site-level key/value settings. Today it holds exactly one row, under
-- key 'site_notice' (the single site-wide notice). Paired with
-- workers/api/src/db/schema-site-settings.ts. Worker-local island — not in the
-- published @buildinternet/releases-core schema.
CREATE TABLE IF NOT EXISTS site_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
