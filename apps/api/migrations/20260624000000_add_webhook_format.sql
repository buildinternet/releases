-- Webhook delivery format: json (default, signed raw event) or slack (Block Kit, unsigned).
ALTER TABLE webhook_subscriptions ADD COLUMN format TEXT NOT NULL DEFAULT 'json' CHECK(format IN ('json', 'slack'));
