-- Account interest-alert activity (#2320).
-- The primary key (alert_id, release_id) does not order by time. This index
-- serves the list read: a 30-day count range and one latest row per alert.
-- No new matcher writes. Paired with semanticAlertMatches in
-- apps/api/src/db/schema-semantic-alerts.ts.
CREATE INDEX IF NOT EXISTS idx_semantic_alert_matches_alert_created
  ON semantic_alert_matches (alert_id, created_at);
