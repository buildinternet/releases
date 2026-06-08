-- Per-user feed tokens: the credential embedded in a personalized Atom feed URL.
-- Paired with workers/api/src/db/schema-feed-tokens.ts.
-- Reversible: `secret` is stored plaintext (public-data feed, no PII) so the
-- full URL is re-revealable. One row per user.
CREATE TABLE IF NOT EXISTS user_feed_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  lookup_id    TEXT NOT NULL,
  secret       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_feed_tokens_user
  ON user_feed_tokens (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_feed_tokens_lookup
  ON user_feed_tokens (lookup_id);
