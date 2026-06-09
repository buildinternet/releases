-- User digest email preferences: cadence (off/daily/weekly), the published-date
-- watermark (last_digest_at), and the opaque reld_ manage token for the no-login
-- unsubscribe lane. Paired with workers/api/src/db/schema-digest-prefs.ts.
CREATE TABLE IF NOT EXISTS user_digest_prefs (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  cadence        TEXT NOT NULL DEFAULT 'off',
  last_digest_at INTEGER,
  manage_token   TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_digest_prefs_user
  ON user_digest_prefs (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_digest_prefs_token
  ON user_digest_prefs (manage_token);
CREATE INDEX IF NOT EXISTS idx_user_digest_prefs_cadence
  ON user_digest_prefs (cadence);
