-- Workspace-owned webhooks (#2324): a subscription is owned by a user, a
-- workspace, or neither (admin-provisioned), never both.
ALTER TABLE webhook_subscriptions ADD COLUMN workspace_id TEXT REFERENCES organization(id) ON DELETE CASCADE CHECK (workspace_id IS NULL OR user_id IS NULL);

CREATE INDEX IF NOT EXISTS idx_webhook_subs_workspace ON webhook_subscriptions (workspace_id);
