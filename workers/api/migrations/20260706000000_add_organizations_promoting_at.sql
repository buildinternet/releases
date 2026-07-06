-- Serialize per-org promotion (#1958). `promoting_at` is a transient claim
-- timestamp: promoteStubOrg takes an atomic conditional UPDATE claim before
-- doing any materialization work, so two concurrent promotions of the same
-- org can't both pass the tier check and race on the per-org source insert.
-- NULL when no promotion is in flight. A stale claim (older than a 10-minute
-- TTL enforced in application code) is treated as free, self-healing a run
-- that crashed before reaching its `finally` release. Internal-only — never
-- exposed on any read surface or in api-types.
ALTER TABLE organizations ADD COLUMN promoting_at TEXT;
