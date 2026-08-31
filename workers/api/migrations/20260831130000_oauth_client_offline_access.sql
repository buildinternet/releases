-- Refresh tokens are only issued when the grant carries `offline_access`
-- (@better-auth/oauth-provider's isRefreshToken guard). New registrations get
-- it from the provider `scopes` list, which is the DCR default; this backfills
-- every existing oauth_client row so already-registered clients (Claude
-- Desktop, MCP Inspector, opencode, Cursor, ...) can hold refresh tokens
-- without re-registering. `scopes` is a JSON TEXT array; json_insert('$[#]')
-- appends. Rows already carrying the scope are skipped, so this is idempotent
-- and safe to re-run against previews.
-- Ported from buildinternet/uploads#913.
UPDATE oauth_client
SET scopes = json_insert(scopes, '$[#]', 'offline_access')
WHERE scopes IS NOT NULL
  AND json_valid(scopes)
  AND json_type(scopes) = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(oauth_client.scopes)
    WHERE json_each.value = 'offline_access'
  );
