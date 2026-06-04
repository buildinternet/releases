-- Better Auth core schema: user / session / account / verification.
-- Paired with workers/api/src/db/schema-auth.ts (worker-local schema island;
-- not part of the published @buildinternet/releases-core schema). Human user
-- sessions — a separate layer from the relk_ machine tokens in api_tokens.
--
-- Timestamps are integer (Drizzle `timestamp` mode = epoch seconds); booleans
-- are integer (0/1). Table names are Better Auth defaults; no existing table
-- collides with user/session/account/verification.

CREATE TABLE user (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  email_verified integer NOT NULL DEFAULT 0,
  image text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX idx_user_email ON user (email);

CREATE TABLE session (
  id text PRIMARY KEY NOT NULL,
  user_id text NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  token text NOT NULL,
  expires_at integer NOT NULL,
  ip_address text,
  user_agent text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX idx_session_token ON session (token);
CREATE INDEX idx_session_user_id ON session (user_id);

CREATE TABLE account (
  id text PRIMARY KEY NOT NULL,
  user_id text NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  access_token text,
  refresh_token text,
  access_token_expires_at integer,
  refresh_token_expires_at integer,
  scope text,
  id_token text,
  password text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX idx_account_user_id ON account (user_id);

CREATE TABLE verification (
  id text PRIMARY KEY NOT NULL,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX idx_verification_identifier ON verification (identifier);
