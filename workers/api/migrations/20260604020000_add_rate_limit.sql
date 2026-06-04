-- Better Auth database-backed rate-limit store (rateLimit.storage: "database").
-- Paired with the `rateLimit` table in workers/api/src/db/schema-auth.ts (the
-- schema↔migration pairing gate in ci.yml watches that file). Keeps rate-limit
-- counters in D1 so they hold across Worker isolates — Better Auth's in-memory
-- default resets per isolate and is useless on serverless. Column set is mandated by
-- Better Auth: id (pk) / key (unique lookup key) / count / last_request (epoch ms).
CREATE TABLE rate_limit (
  id text PRIMARY KEY NOT NULL,
  key text NOT NULL,
  count integer NOT NULL,
  last_request integer NOT NULL
);
CREATE UNIQUE INDEX idx_rate_limit_key ON rate_limit (key);
