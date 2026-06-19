-- Tracks when the current consecutive-failure streak began (cleared on success).
-- Powers time-based auto-pause for low-volume user webhooks.
ALTER TABLE webhook_subscriptions ADD COLUMN failure_streak_started_at TEXT;