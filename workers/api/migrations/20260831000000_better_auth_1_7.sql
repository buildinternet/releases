-- Better Auth 1.6.25 → 1.7.2 auth-schema migration.
--
-- Additive + backfill only (no drops, no NOT NULL added to a populated table),
-- so it is safe to apply ahead of the deploy and safe to leave applied if the
-- worker is rolled back — 1.6 ignores the new columns and tables.
--
-- Shapes taken from `getAuthTables()` in the installed 1.7.2 packages.

-- ── (1) account: 1.7 keys account identity on (issuer, accountId) ──
-- Nullable at the DB level (SQLite can't add a NOT NULL column to a populated
-- table); Better Auth always populates it on insert. Backfill mirrors
-- `createOAuthAccountIssuer` / `createLocalAccountIssuer` from @better-auth/core.
ALTER TABLE account ADD COLUMN issuer TEXT;
UPDATE account
SET issuer = CASE
  WHEN provider_id = 'credential' THEN 'local:credential'
  ELSE 'local:oauth:' || provider_id
END
WHERE issuer IS NULL;
-- Lookup index for findAccountByKey({ issuer, accountId }). Deliberately NOT
-- unique: uniqueness is not required by the plugin, and a non-unique index
-- can't fail on legacy duplicate (provider, accountId) pairs.
CREATE INDEX idx_account_issuer_account_id ON account (issuer, account_id);

-- ── (2) jwks: signing algorithm + curve persisted per key ──
ALTER TABLE jwks ADD COLUMN alg TEXT;
ALTER TABLE jwks ADD COLUMN crv TEXT;

-- ── (3) oauth_client: OIDC/DCR metadata added in 1.7 ──
ALTER TABLE oauth_client ADD COLUMN client_discovery_id TEXT;
ALTER TABLE oauth_client ADD COLUMN client_credentials_scopes TEXT;
ALTER TABLE oauth_client ADD COLUMN backchannel_logout_uri TEXT;
ALTER TABLE oauth_client ADD COLUMN backchannel_logout_session_required INTEGER;
ALTER TABLE oauth_client ADD COLUMN application_type TEXT;
ALTER TABLE oauth_client ADD COLUMN jwks TEXT;
ALTER TABLE oauth_client ADD COLUMN jwks_uri TEXT;
ALTER TABLE oauth_client ADD COLUMN dpop_bound_access_tokens INTEGER;

-- ── (4) oauth_access_token: resource binding, revocation, DPoP confirmation ──
ALTER TABLE oauth_access_token ADD COLUMN authorization_code_id TEXT;
ALTER TABLE oauth_access_token ADD COLUMN resources TEXT;
ALTER TABLE oauth_access_token ADD COLUMN requested_user_info_claims TEXT;
ALTER TABLE oauth_access_token ADD COLUMN confirmation TEXT;
ALTER TABLE oauth_access_token ADD COLUMN revoked INTEGER;
CREATE INDEX idx_oauth_access_authorization_code_id
  ON oauth_access_token (authorization_code_id);

-- ── (5) oauth_refresh_token: resource binding + rotation-replay window ──
-- The rotation_replay_* columns are what `refreshTokenReuseInterval` writes:
-- a refresh token presented again inside the grace window replays the stored
-- rotation response instead of revoking the token family.
ALTER TABLE oauth_refresh_token ADD COLUMN authorization_code_id TEXT;
ALTER TABLE oauth_refresh_token ADD COLUMN resources TEXT;
ALTER TABLE oauth_refresh_token ADD COLUMN requested_user_info_claims TEXT;
ALTER TABLE oauth_refresh_token ADD COLUMN rotated_at INTEGER;
ALTER TABLE oauth_refresh_token ADD COLUMN rotation_replay_response TEXT;
ALTER TABLE oauth_refresh_token ADD COLUMN rotation_replay_expires_at INTEGER;
ALTER TABLE oauth_refresh_token ADD COLUMN confirmation TEXT;
CREATE INDEX idx_oauth_refresh_authorization_code_id
  ON oauth_refresh_token (authorization_code_id);

-- ── (6) oauth_consent: resource + requested-claims binding ──
ALTER TABLE oauth_consent ADD COLUMN resources TEXT;
ALTER TABLE oauth_consent ADD COLUMN requested_user_info_claims TEXT;

-- ── (7) Protected-resource model (replaces the 1.6 validAudiences list) ──
-- Rows are seeded at boot from oauthProvider({ resources }) with the plugin's
-- default resourceSeedMode "insertOnly" (boot never overwrites edits).
CREATE TABLE oauth_resource (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  access_token_ttl INTEGER,
  refresh_token_ttl INTEGER,
  signing_algorithm TEXT,
  signing_key_id TEXT,
  allowed_scopes TEXT,
  custom_claims TEXT,
  dpop_bound_access_tokens_required INTEGER,
  disabled INTEGER,
  policy_version INTEGER,
  metadata TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

-- Client ⋈ resource binding. Authoritative only under enforcePerClientResources,
-- which this AS leaves off; present for schema parity.
CREATE TABLE oauth_client_resource (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_client (client_id),
  resource_id TEXT NOT NULL REFERENCES oauth_resource (identifier),
  metadata TEXT,
  created_at INTEGER
);
CREATE UNIQUE INDEX idx_oauth_client_resource_client_resource
  ON oauth_client_resource (client_id, resource_id);

-- Single-use private_key_jwt client-assertion jti store (id = jti, RFC 7523).
CREATE TABLE oauth_client_assertion (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
