-- Issue #676: collapse notOnDemand into an organizations_public view.
--
-- organizations_active (from #671) already strips tombstoned rows.
-- This view layers on top to also strip on-demand rows — orgs that were
-- materialized by the /v1/lookups endpoint and should not appear in the
-- public catalog.
--
-- Public catalog read paths (taxonomy, related-org, overview-inputs, …)
-- were applying notOnDemand(organizationsActive.discovery) at every call
-- site. Those sites now SELECT from this view instead, which lets the
-- planner inline both predicates and removes the per-site boilerplate.
--
-- Admin-only paths that need to see on-demand orgs (lookups, restore
-- endpoints, embed backfills) keep using organizationsActive or the base
-- organizations table.
--
-- The `discovery IS NULL` arm should never fire in practice — the column
-- is NOT NULL DEFAULT 'curated' — but it matches the previous
-- notOnDemand() helper so there is no behavior drift.

CREATE VIEW IF NOT EXISTS organizations_public AS
  SELECT * FROM organizations_active
  WHERE discovery <> 'on_demand' OR discovery IS NULL;
