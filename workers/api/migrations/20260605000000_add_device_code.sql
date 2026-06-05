-- Better Auth device-authorization plugin (deviceAuthorization) store — the OAuth
-- 2.0 Device Authorization Grant (RFC 8628) pending-request table backing
-- `releases login` from the CLI. Paired with the `deviceCode` table in
-- workers/api/src/db/schema-auth.ts (the schema↔migration pairing gate in ci.yml
-- watches that file). Field set is mandated by the plugin (its schema.mjs) — note
-- there are NO created_at/updated_at columns. SQL name is snake_case; the
-- drizzle-adapter schema KEY stays the camelCase model name `deviceCode`.
CREATE TABLE device_code (
  id text PRIMARY KEY NOT NULL,
  device_code text NOT NULL,
  user_code text NOT NULL,
  user_id text,
  expires_at integer NOT NULL,
  status text NOT NULL,
  last_polled_at integer,
  polling_interval integer,
  client_id text,
  scope text
);
CREATE INDEX idx_device_code_device_code ON device_code (device_code);
CREATE INDEX idx_device_code_user_code ON device_code (user_code);
