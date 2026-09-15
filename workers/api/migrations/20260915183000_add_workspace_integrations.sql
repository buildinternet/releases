-- Workspace-scoped third-party OAuth connections (uploads.sh in v1).
-- Tokens and the PKCE verifier are stored AES-256-GCM encrypted; this table
-- never holds plaintext secrets. UNIQUE(workspace_id, provider) is one
-- connection per workspace per provider.

CREATE TABLE workspace_integrations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  oauth_state TEXT,
  code_verifier_enc TEXT,
  redirect_uri TEXT,
  pending_expires_at INTEGER,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  token_type TEXT,
  scope TEXT,
  access_token_expires_at INTEGER,
  connected_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_workspace_integrations_unique
  ON workspace_integrations (workspace_id, provider);
CREATE INDEX idx_workspace_integrations_state
  ON workspace_integrations (oauth_state);
CREATE INDEX idx_workspace_integrations_workspace
  ON workspace_integrations (workspace_id);
