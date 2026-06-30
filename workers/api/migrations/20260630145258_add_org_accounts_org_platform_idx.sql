-- Backs the correlated github-handle subquery run once per org row across
-- collections (list/detail/feed), queries/releases.ts getLatestReleasesAcross,
-- and packages/core-internal collection-feed:
--   SELECT handle FROM org_accounts WHERE org_id = ? AND platform = 'github' ...
-- The only existing index is UNIQUE(platform, handle), which can't service an
-- org_id-leading lookup, so each site was an unindexed scan per row (#1800).
CREATE INDEX IF NOT EXISTS idx_org_accounts_org_platform
  ON org_accounts (org_id, platform);
