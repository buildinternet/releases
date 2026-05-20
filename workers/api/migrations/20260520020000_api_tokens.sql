-- Scoped, DB-backed API tokens. Opaque split format: a public lookup_id plus a
-- SHA-256 hash of the secret. See
-- docs/superpowers/specs/2026-05-20-scoped-api-tokens-design.md
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  lookup_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  scopes TEXT NOT NULL,
  principal_type TEXT NOT NULL DEFAULT 'internal' CHECK (principal_type IN ('internal', 'agent', 'user')),
  principal_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  revoked_at TEXT,
  expires_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT,
  metadata TEXT DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_lookup_id ON api_tokens (lookup_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_principal ON api_tokens (principal_type, principal_id);
