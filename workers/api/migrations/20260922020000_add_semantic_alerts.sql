-- Semantic alerts: user-owned freeform interests (#2304 Phase 1).
-- Preferences only — no matcher, no delivery. Paired with
-- workers/api/src/db/schema-semantic-alerts.ts.
CREATE TABLE IF NOT EXISTS semantic_alerts (
  id                      TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  query                   TEXT NOT NULL,
  enabled                 INTEGER NOT NULL DEFAULT 1,
  threshold               REAL NOT NULL DEFAULT 0.8,
  deliver_email           INTEGER NOT NULL DEFAULT 1,
  deliver_webhook         INTEGER NOT NULL DEFAULT 0,
  webhook_subscription_id TEXT REFERENCES webhook_subscriptions(id) ON DELETE SET NULL,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_semantic_alerts_user
  ON semantic_alerts (user_id);
