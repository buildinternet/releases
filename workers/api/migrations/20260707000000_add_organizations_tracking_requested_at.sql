-- workers/api/migrations/20260707000000_add_organizations_tracking_requested_at.sql
-- Owner demand signal for the promotion loop (#1947 phase 2). Stamped when a
-- domain owner requests tracking via the self-serve listing lane
-- (POST /v1/listing/activate with requestTracking: true), on stub creation or
-- on the existing-stub carve-out; repeat requests refresh it. NULL = never
-- requested. Internal-only — read via admin surfaces, not public api-types.
ALTER TABLE organizations ADD COLUMN tracking_requested_at TEXT;
