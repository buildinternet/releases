-- Follows-scoped webhook subscriptions: scope='follows' rows have null org_id.
PRAGMA foreign_keys=OFF;

CREATE TABLE webhook_subscriptions_new (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  scope                    TEXT NOT NULL DEFAULT 'org' CHECK (scope IN ('org', 'follows')),
  org_id                   TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  url                      TEXT NOT NULL,
  source_id                TEXT REFERENCES sources(id) ON DELETE CASCADE,
  enabled                  INTEGER NOT NULL DEFAULT 1,
  description              TEXT,
  secret_version           INTEGER NOT NULL DEFAULT 1,
  created_at               TEXT NOT NULL,
  last_success_at          TEXT,
  last_error_at            TEXT,
  last_error_msg           TEXT,
  failure_streak_started_at TEXT,
  consecutive_failures     INTEGER NOT NULL DEFAULT 0,
  disabled_reason          TEXT
);

INSERT INTO webhook_subscriptions_new (
  id, user_id, scope, org_id, url, source_id, enabled, description,
  secret_version, created_at, last_success_at, last_error_at, last_error_msg,
  failure_streak_started_at, consecutive_failures, disabled_reason
)
SELECT
  id, user_id, 'org', org_id, url, source_id, enabled, description,
  secret_version, created_at, last_success_at, last_error_at, last_error_msg,
  failure_streak_started_at, consecutive_failures, disabled_reason
FROM webhook_subscriptions;

DROP TABLE webhook_subscriptions;
ALTER TABLE webhook_subscriptions_new RENAME TO webhook_subscriptions;

CREATE INDEX idx_webhook_subs_org_enabled ON webhook_subscriptions (org_id, enabled);
CREATE INDEX idx_webhook_subs_org_source ON webhook_subscriptions (org_id, source_id);
CREATE INDEX idx_webhook_subs_user ON webhook_subscriptions (user_id);
CREATE INDEX idx_webhook_subs_scope_enabled ON webhook_subscriptions (scope, enabled);

PRAGMA foreign_keys=ON;