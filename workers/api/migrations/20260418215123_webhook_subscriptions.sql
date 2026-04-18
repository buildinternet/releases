CREATE TABLE webhook_subscriptions (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url                   TEXT NOT NULL,
  source_id             TEXT REFERENCES sources(id) ON DELETE CASCADE,
  enabled               INTEGER NOT NULL DEFAULT 1,
  description           TEXT,
  secret_version        INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  last_success_at       TEXT,
  last_error_at         TEXT,
  last_error_msg        TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  disabled_reason       TEXT
);

CREATE INDEX idx_webhook_subs_org_enabled
  ON webhook_subscriptions (org_id, enabled);
CREATE INDEX idx_webhook_subs_org_source
  ON webhook_subscriptions (org_id, source_id);
