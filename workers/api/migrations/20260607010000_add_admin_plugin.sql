-- Better Auth `admin` plugin (better-auth/plugins) columns. Paired with the
-- role/banned/banReason/banExpires (user) + impersonatedBy (session) fields in
-- workers/api/src/db/schema-auth.ts (the schema↔migration pairing gate in ci.yml
-- watches that file). `role` is nullable (no default): the plugin stamps "user"
-- on new sign-ups at runtime; existing rows stay NULL → read-only (fail-closed).
-- `banned` is integer (boolean mode); ban_expires is integer epoch seconds (timestamp).
ALTER TABLE user ADD COLUMN role text;
ALTER TABLE user ADD COLUMN banned integer;
ALTER TABLE user ADD COLUMN ban_reason text;
ALTER TABLE user ADD COLUMN ban_expires integer;
ALTER TABLE session ADD COLUMN impersonated_by text;
