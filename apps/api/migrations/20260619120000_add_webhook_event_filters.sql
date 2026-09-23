-- Per-event webhook filters: optional product + release type narrowing (#1681).
ALTER TABLE webhook_subscriptions ADD COLUMN product_id TEXT REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE webhook_subscriptions ADD COLUMN release_type TEXT CHECK(release_type IN ('feature', 'rollup') OR release_type IS NULL);
CREATE INDEX idx_webhook_subs_org_product ON webhook_subscriptions(org_id, product_id);