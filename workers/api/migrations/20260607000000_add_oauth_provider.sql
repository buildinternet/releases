-- Better Auth OAuth Provider plugin (@better-auth/oauth-provider) + jwt() keyset.
-- Paired with the oauth_client/oauth_access_token/oauth_refresh_token/
-- oauth_consent/jwks tables in workers/api/src/db/schema-auth.ts (the
-- schema↔migration pairing gate in ci.yml watches that file). string[] columns
-- are JSON text; timestamps are integer epoch ms (Better Auth Drizzle shape).
CREATE TABLE oauth_client (
  id text PRIMARY KEY NOT NULL,
  client_id text NOT NULL UNIQUE,
  client_secret text,
  name text,
  icon text,
  uri text,
  redirect_uris text NOT NULL,
  post_logout_redirect_uris text,
  scopes text NOT NULL,
  grant_types text,
  response_types text,
  contacts text,
  token_endpoint_auth_method text,
  type text,
  public integer,
  require_pkce integer,
  disabled integer,
  skip_consent integer,
  enable_end_session integer,
  subject_type text,
  tos text,
  policy text,
  software_id text,
  software_version text,
  software_statement text,
  user_id text,
  reference_id text,
  metadata text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX idx_oauth_client_client_id ON oauth_client (client_id);

CREATE TABLE oauth_access_token (
  id text PRIMARY KEY NOT NULL,
  token text NOT NULL UNIQUE,
  client_id text NOT NULL,
  session_id text REFERENCES session(id) ON DELETE SET NULL,
  refresh_id text,
  user_id text,
  reference_id text,
  scopes text NOT NULL,
  created_at integer NOT NULL,
  expires_at integer NOT NULL
);
CREATE INDEX idx_oauth_access_token_token ON oauth_access_token (token);

CREATE TABLE oauth_refresh_token (
  id text PRIMARY KEY NOT NULL,
  token text NOT NULL UNIQUE,
  client_id text NOT NULL,
  session_id text REFERENCES session(id) ON DELETE SET NULL,
  user_id text NOT NULL,
  reference_id text,
  scopes text NOT NULL,
  revoked integer, -- epoch ms; NULL = not revoked
  auth_time integer,
  created_at integer NOT NULL,
  expires_at integer NOT NULL
);
CREATE INDEX idx_oauth_refresh_token_token ON oauth_refresh_token (token);

CREATE TABLE oauth_consent (
  id text PRIMARY KEY NOT NULL,
  user_id text NOT NULL,
  client_id text NOT NULL,
  reference_id text,
  scopes text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX idx_oauth_consent_user_client ON oauth_consent (user_id, client_id);

CREATE TABLE jwks (
  id text PRIMARY KEY NOT NULL,
  public_key text NOT NULL,
  private_key text NOT NULL,
  created_at integer NOT NULL,
  expires_at integer
);
