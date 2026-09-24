-- Ending a verified ownership claim (#2389): the row is kept with
-- status = 'revoked', plus when, by whom ('owner', 'root', or 'token:<id>'),
-- and why. SQLite cannot ALTER a CHECK constraint in place, so rebuild the
-- table to widen the status CHECK (same pattern as
-- 20260915220000_add_webhook_format_discord.sql). Nothing references
-- org_claims by foreign key.
PRAGMA foreign_keys=OFF;

CREATE TABLE org_claims_new (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  method TEXT CHECK (method IN ('well-known', 'dns-txt')),
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'expired', 'revoked')),
  created_at TEXT NOT NULL,
  verified_at TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT,
  revoke_reason TEXT
);

INSERT INTO org_claims_new (
  id, org_id, user_id, method, token, status, created_at, verified_at, expires_at
)
SELECT
  id, org_id, user_id, method, token, status, created_at, verified_at, expires_at
FROM org_claims;

DROP TABLE org_claims;
ALTER TABLE org_claims_new RENAME TO org_claims;

CREATE INDEX idx_org_claims_org_user ON org_claims (org_id, user_id);
CREATE INDEX idx_org_claims_user ON org_claims (user_id);

PRAGMA foreign_keys=ON;
