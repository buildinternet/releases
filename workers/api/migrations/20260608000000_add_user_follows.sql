-- User follows: a signed-in user following an org or product.
-- Paired with workers/api/src/db/schema-follows.ts.
CREATE TABLE IF NOT EXISTS user_follows (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_follows_unique
  ON user_follows (user_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_user
  ON user_follows (user_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_target
  ON user_follows (target_type, target_id);
