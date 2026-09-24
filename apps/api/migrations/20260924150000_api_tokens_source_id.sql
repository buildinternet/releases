-- Owner-scoped publish tokens (#2373): a `publish`-scoped api_tokens row is
-- bound to one source. Null on every ladder (read/write/admin) token.
ALTER TABLE api_tokens ADD COLUMN source_id TEXT REFERENCES sources(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_api_tokens_source ON api_tokens (source_id);
