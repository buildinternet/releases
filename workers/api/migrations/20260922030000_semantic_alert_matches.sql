-- Semantic alert match idempotency (#2304 Phase 2).
-- One row per (alert, release) so a republish does not send again.
-- Query text is not stored. Paired with semanticAlertMatches in
-- workers/api/src/db/schema-semantic-alerts.ts.
CREATE TABLE IF NOT EXISTS semantic_alert_matches (
  alert_id    TEXT NOT NULL REFERENCES semantic_alerts(id) ON DELETE CASCADE,
  release_id  TEXT NOT NULL,
  probability REAL NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (alert_id, release_id)
);
