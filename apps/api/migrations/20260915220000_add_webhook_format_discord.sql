-- Widen webhook_subscriptions.format CHECK to include discord.
-- SQLite cannot ALTER a CHECK constraint in place, so rebuild the table.
PRAGMA foreign_keys=OFF;

CREATE TABLE webhook_subscriptions_new (
  id                        TEXT PRIMARY KEY,
  user_id                   TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  scope                     TEXT NOT NULL DEFAULT 'org' CHECK (scope IN ('org', 'follows')),
  org_id                    TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  url                       TEXT NOT NULL,
  source_id                 TEXT REFERENCES sources(id) ON DELETE CASCADE,
  product_id                TEXT REFERENCES products(id) ON DELETE CASCADE,
  release_type              TEXT CHECK (release_type IN ('feature', 'rollup') OR release_type IS NULL),
  enabled                   INTEGER NOT NULL DEFAULT 1,
  description               TEXT,
  format                    TEXT NOT NULL DEFAULT 'json' CHECK (format IN ('json', 'slack', 'discord')),
  secret_version            INTEGER NOT NULL DEFAULT 1,
  created_at                TEXT NOT NULL,
  last_success_at           TEXT,
  last_error_at             TEXT,
  last_error_msg            TEXT,
  failure_streak_started_at TEXT,
  consecutive_failures      INTEGER NOT NULL DEFAULT 0,
  disabled_reason           TEXT
);

INSERT INTO webhook_subscriptions_new (
  id, user_id, scope, org_id, url, source_id, product_id, release_type,
  enabled, description, format, secret_version, created_at, last_success_at,
  last_error_at, last_error_msg, failure_streak_started_at, consecutive_failures,
  disabled_reason
)
SELECT
  id, user_id, scope, org_id, url, source_id, product_id, release_type,
  enabled, description, format, secret_version, created_at, last_success_at,
  last_error_at, last_error_msg, failure_streak_started_at, consecutive_failures,
  disabled_reason
FROM webhook_subscriptions;

DROP TABLE webhook_subscriptions;
ALTER TABLE webhook_subscriptions_new RENAME TO webhook_subscriptions;

CREATE INDEX idx_webhook_subs_org_enabled ON webhook_subscriptions (org_id, enabled);
CREATE INDEX idx_webhook_subs_org_source ON webhook_subscriptions (org_id, source_id);
CREATE INDEX idx_webhook_subs_org_product ON webhook_subscriptions (org_id, product_id);
CREATE INDEX idx_webhook_subs_user ON webhook_subscriptions (user_id);
CREATE INDEX idx_webhook_subs_scope_enabled ON webhook_subscriptions (scope, enabled);

PRAGMA foreign_keys=ON;
