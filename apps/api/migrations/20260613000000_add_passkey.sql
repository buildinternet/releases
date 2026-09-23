-- Add the `passkey` table for the Better Auth passkey plugin (`@better-auth/passkey`)
-- — WebAuthn / FIDO2 credentials, one row per registered passkey. Paired with the
-- `passkey` table in workers/api/src/db/schema-auth.ts (the schema↔migration pairing
-- gate in ci.yml watches that file). Field set + names are mandated by the plugin's
-- schema; `user_id` cascades on user delete, and `user_id` / `credential_id` carry
-- the plugin's declared indexes. SQL columns are snake_case; the drizzle-adapter
-- schema KEY stays the camelCase model name `passkey`.
CREATE TABLE passkey (
  id text PRIMARY KEY NOT NULL,
  name text,
  public_key text NOT NULL,
  user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  credential_id text NOT NULL,
  counter integer NOT NULL,
  device_type text NOT NULL,
  backed_up integer NOT NULL,
  transports text,
  created_at integer,
  aaguid text
);
CREATE INDEX idx_passkey_user_id ON passkey (user_id);
CREATE INDEX idx_passkey_credential_id ON passkey (credential_id);
