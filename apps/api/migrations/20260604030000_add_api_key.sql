-- Better Auth API key plugin (@better-auth/api-key) store — user-owned, metered
-- API keys (prefix relu_). Paired with the `apikey` table in
-- workers/api/src/db/schema-auth.ts (the schema↔migration pairing gate in ci.yml
-- watches that file). referenceId = owning user id (config references: "user").
-- permissions is a JSON string encoding the scope ladder as cumulative actions on
-- one `api` resource. Reconcile columns with `@better-auth/cli generate`.
CREATE TABLE apikey (
  id text PRIMARY KEY NOT NULL,
  name text,
  start text,
  prefix text,
  key text NOT NULL,
  reference_id text NOT NULL,
  config_id text,
  refill_interval integer,
  refill_amount integer,
  last_refill_at integer,
  enabled integer,
  rate_limit_enabled integer,
  rate_limit_time_window integer,
  rate_limit_max integer,
  request_count integer,
  remaining integer,
  last_request integer,
  expires_at integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  permissions text,
  metadata text
);
CREATE INDEX idx_apikey_key ON apikey (key);
CREATE INDEX idx_apikey_reference_id ON apikey (reference_id);
