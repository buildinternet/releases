-- Normalize double-JSON-encoded columns on the Better Auth OAuth tables.
--
-- Root cause (writer side, fixed in the same PR): the Better Auth adapter
-- factory serializes `json` / `string[]` fields itself whenever the backend
-- reports `supportsJSON: false` / `supportsArrays: false`, which the drizzle
-- adapter does for every non-`pg` provider (SQLite/D1 included). Our drizzle
-- schema then declared the same columns `text(..., { mode: "json" })`, which
-- stringifies a SECOND time — so rows land as a JSON *string* containing JSON
-- (`json_type(scopes) = 'text'`). Every prod `oauth_client` row back to June
-- 2026 carries it, plus the issued-token and consent scope columns.
--
-- Consequences: the #2256 offline_access backfill was a silent no-op (its
-- `json_type(scopes) = 'array'` guard never matched), and direct drizzle reads
-- such as `registeredScopesForClientId` got a string where an array was
-- declared, emptying the authorize `scope=` rewrite.
--
-- Each statement is idempotent and conservative: it rewrites ONLY rows where
-- the column is a JSON string whose inner text is itself valid JSON of the
-- expected shape. Healthy rows (already `array` / `object`) and genuinely
-- scalar text are left untouched, so this is safe to re-run.

-- oauth_client: array columns
UPDATE oauth_client SET redirect_uris = json_extract(redirect_uris, '$')
WHERE redirect_uris IS NOT NULL AND json_valid(redirect_uris) AND json_type(redirect_uris) = 'text'
  AND json_valid(json_extract(redirect_uris, '$')) AND json_type(json_extract(redirect_uris, '$')) = 'array';

UPDATE oauth_client SET post_logout_redirect_uris = json_extract(post_logout_redirect_uris, '$')
WHERE post_logout_redirect_uris IS NOT NULL AND json_valid(post_logout_redirect_uris) AND json_type(post_logout_redirect_uris) = 'text'
  AND json_valid(json_extract(post_logout_redirect_uris, '$')) AND json_type(json_extract(post_logout_redirect_uris, '$')) = 'array';

UPDATE oauth_client SET scopes = json_extract(scopes, '$')
WHERE scopes IS NOT NULL AND json_valid(scopes) AND json_type(scopes) = 'text'
  AND json_valid(json_extract(scopes, '$')) AND json_type(json_extract(scopes, '$')) = 'array';

UPDATE oauth_client SET grant_types = json_extract(grant_types, '$')
WHERE grant_types IS NOT NULL AND json_valid(grant_types) AND json_type(grant_types) = 'text'
  AND json_valid(json_extract(grant_types, '$')) AND json_type(json_extract(grant_types, '$')) = 'array';

UPDATE oauth_client SET response_types = json_extract(response_types, '$')
WHERE response_types IS NOT NULL AND json_valid(response_types) AND json_type(response_types) = 'text'
  AND json_valid(json_extract(response_types, '$')) AND json_type(json_extract(response_types, '$')) = 'array';

UPDATE oauth_client SET contacts = json_extract(contacts, '$')
WHERE contacts IS NOT NULL AND json_valid(contacts) AND json_type(contacts) = 'text'
  AND json_valid(json_extract(contacts, '$')) AND json_type(json_extract(contacts, '$')) = 'array';

UPDATE oauth_client SET client_credentials_scopes = json_extract(client_credentials_scopes, '$')
WHERE client_credentials_scopes IS NOT NULL AND json_valid(client_credentials_scopes) AND json_type(client_credentials_scopes) = 'text'
  AND json_valid(json_extract(client_credentials_scopes, '$')) AND json_type(json_extract(client_credentials_scopes, '$')) = 'array';

UPDATE oauth_client SET metadata = json_extract(metadata, '$')
WHERE metadata IS NOT NULL AND json_valid(metadata) AND json_type(metadata) = 'text'
  AND json_valid(json_extract(metadata, '$')) AND json_type(json_extract(metadata, '$')) IN ('array', 'object');

-- oauth_access_token
UPDATE oauth_access_token SET scopes = json_extract(scopes, '$')
WHERE scopes IS NOT NULL AND json_valid(scopes) AND json_type(scopes) = 'text'
  AND json_valid(json_extract(scopes, '$')) AND json_type(json_extract(scopes, '$')) = 'array';

UPDATE oauth_access_token SET resources = json_extract(resources, '$')
WHERE resources IS NOT NULL AND json_valid(resources) AND json_type(resources) = 'text'
  AND json_valid(json_extract(resources, '$')) AND json_type(json_extract(resources, '$')) = 'array';

UPDATE oauth_access_token SET requested_user_info_claims = json_extract(requested_user_info_claims, '$')
WHERE requested_user_info_claims IS NOT NULL AND json_valid(requested_user_info_claims) AND json_type(requested_user_info_claims) = 'text'
  AND json_valid(json_extract(requested_user_info_claims, '$')) AND json_type(json_extract(requested_user_info_claims, '$')) = 'array';

UPDATE oauth_access_token SET confirmation = json_extract(confirmation, '$')
WHERE confirmation IS NOT NULL AND json_valid(confirmation) AND json_type(confirmation) = 'text'
  AND json_valid(json_extract(confirmation, '$')) AND json_type(json_extract(confirmation, '$')) IN ('array', 'object');

-- oauth_refresh_token
UPDATE oauth_refresh_token SET scopes = json_extract(scopes, '$')
WHERE scopes IS NOT NULL AND json_valid(scopes) AND json_type(scopes) = 'text'
  AND json_valid(json_extract(scopes, '$')) AND json_type(json_extract(scopes, '$')) = 'array';

UPDATE oauth_refresh_token SET resources = json_extract(resources, '$')
WHERE resources IS NOT NULL AND json_valid(resources) AND json_type(resources) = 'text'
  AND json_valid(json_extract(resources, '$')) AND json_type(json_extract(resources, '$')) = 'array';

UPDATE oauth_refresh_token SET requested_user_info_claims = json_extract(requested_user_info_claims, '$')
WHERE requested_user_info_claims IS NOT NULL AND json_valid(requested_user_info_claims) AND json_type(requested_user_info_claims) = 'text'
  AND json_valid(json_extract(requested_user_info_claims, '$')) AND json_type(json_extract(requested_user_info_claims, '$')) = 'array';

UPDATE oauth_refresh_token SET confirmation = json_extract(confirmation, '$')
WHERE confirmation IS NOT NULL AND json_valid(confirmation) AND json_type(confirmation) = 'text'
  AND json_valid(json_extract(confirmation, '$')) AND json_type(json_extract(confirmation, '$')) IN ('array', 'object');

-- oauth_consent
UPDATE oauth_consent SET scopes = json_extract(scopes, '$')
WHERE scopes IS NOT NULL AND json_valid(scopes) AND json_type(scopes) = 'text'
  AND json_valid(json_extract(scopes, '$')) AND json_type(json_extract(scopes, '$')) = 'array';

UPDATE oauth_consent SET resources = json_extract(resources, '$')
WHERE resources IS NOT NULL AND json_valid(resources) AND json_type(resources) = 'text'
  AND json_valid(json_extract(resources, '$')) AND json_type(json_extract(resources, '$')) = 'array';

UPDATE oauth_consent SET requested_user_info_claims = json_extract(requested_user_info_claims, '$')
WHERE requested_user_info_claims IS NOT NULL AND json_valid(requested_user_info_claims) AND json_type(requested_user_info_claims) = 'text'
  AND json_valid(json_extract(requested_user_info_claims, '$')) AND json_type(json_extract(requested_user_info_claims, '$')) = 'array';

-- oauth_resource
UPDATE oauth_resource SET allowed_scopes = json_extract(allowed_scopes, '$')
WHERE allowed_scopes IS NOT NULL AND json_valid(allowed_scopes) AND json_type(allowed_scopes) = 'text'
  AND json_valid(json_extract(allowed_scopes, '$')) AND json_type(json_extract(allowed_scopes, '$')) = 'array';

UPDATE oauth_resource SET custom_claims = json_extract(custom_claims, '$')
WHERE custom_claims IS NOT NULL AND json_valid(custom_claims) AND json_type(custom_claims) = 'text'
  AND json_valid(json_extract(custom_claims, '$')) AND json_type(json_extract(custom_claims, '$')) IN ('array', 'object');

UPDATE oauth_resource SET metadata = json_extract(metadata, '$')
WHERE metadata IS NOT NULL AND json_valid(metadata) AND json_type(metadata) = 'text'
  AND json_valid(json_extract(metadata, '$')) AND json_type(json_extract(metadata, '$')) IN ('array', 'object');

-- oauth_client_resource
UPDATE oauth_client_resource SET metadata = json_extract(metadata, '$')
WHERE metadata IS NOT NULL AND json_valid(metadata) AND json_type(metadata) = 'text'
  AND json_valid(json_extract(metadata, '$')) AND json_type(json_extract(metadata, '$')) IN ('array', 'object');

-- Re-apply the #2256 offline_access backfill (migration
-- 20260831130000_oauth_client_offline_access.sql), which was a no-op on any
-- database whose rows were double-encoded at the time it ran. Runs AFTER the
-- normalization above, so `json_type(scopes) = 'array'` now matches. Refresh
-- tokens are only issued when the grant carries `offline_access`, so without
-- this, clients registered before #2256 can never hold one.
UPDATE oauth_client
SET scopes = json_insert(scopes, '$[#]', 'offline_access')
WHERE scopes IS NOT NULL
  AND json_valid(scopes)
  AND json_type(scopes) = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(oauth_client.scopes)
    WHERE json_each.value = 'offline_access'
  );
