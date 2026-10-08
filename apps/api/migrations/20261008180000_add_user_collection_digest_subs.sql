-- Per-collection weekly digest email subscriptions (#2459). last_sent_week is the
-- exactly-once guard (ET-Monday weekStart of the last digest mailed). Paired with
-- apps/api/src/db/schema-collection-digest-subs.ts.
CREATE TABLE IF NOT EXISTS user_collection_digest_subs (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  collection_id  TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  last_sent_week TEXT,
  created_at     INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_collection_digest_subs_unique
  ON user_collection_digest_subs (user_id, collection_id);
CREATE INDEX IF NOT EXISTS idx_user_collection_digest_subs_collection
  ON user_collection_digest_subs (collection_id);
