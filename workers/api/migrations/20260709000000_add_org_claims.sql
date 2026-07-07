-- Ownership claim flow (#1947 epic item 2).
--
-- org_claims — a signed-in user's proof-of-control attempt for a listed
-- domain. Multiple pending claims may coexist for the same (org, user); the
-- route layer treats at most one `verified` row per (org, user) as
-- meaningful (re-verifying is idempotent).
CREATE TABLE org_claims (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  method TEXT CHECK (method IN ('well-known', 'dns-txt')),
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'expired')),
  created_at TEXT NOT NULL,
  verified_at TEXT,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_org_claims_org_user ON org_claims (org_id, user_id);
CREATE INDEX idx_org_claims_user ON org_claims (user_id);
