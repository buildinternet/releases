-- User-owned webhook subscriptions (self-serve /v1/me/webhooks). Nullable so
-- admin-provisioned rows (RELEASES_API_KEY lane) stay org-scoped with no owner.
ALTER TABLE webhook_subscriptions ADD COLUMN user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_webhook_subs_user
  ON webhook_subscriptions (user_id);