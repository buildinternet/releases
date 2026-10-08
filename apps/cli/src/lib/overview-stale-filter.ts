import type { OrgListItem } from "@buildinternet/releases-api-types";

export const STALE_MIN_RELEASES_DEFAULT = 5;
export const STALE_GRACE_DAYS_DEFAULT = 7;

export interface StaleFilterOpts {
  minReleases?: number;
  graceDays?: number;
}

/** Minimal overview shape needed for the staleness check. */
export interface OverviewMeta {
  updatedAt: string;
}

export interface OrgWithOverview extends OrgListItem {
  overview?: OverviewMeta | null;
}

/**
 * Pure predicate: returns true if the org's overview is considered stale by
 * user-impact. An org is stale when:
 *   - it has recent activity (recentReleaseCount > minReleases), AND
 *   - its overview is either missing OR the org's lastActivity timestamp is
 *     more than graceDays after the overview's updatedAt
 *
 * @param org  - OrgListItem with an optional overview attached
 * @param opts - tunable thresholds (defaults: minReleases=5, graceDays=7)
 */
export function isOrgOverviewStale(org: OrgWithOverview, opts: StaleFilterOpts = {}): boolean {
  const minReleases = opts.minReleases ?? STALE_MIN_RELEASES_DEFAULT;
  const graceDays = opts.graceDays ?? STALE_GRACE_DAYS_DEFAULT;

  if (org.recentReleaseCount <= minReleases) return false;

  if (!org.overview) return true;

  if (!org.lastActivity) return false;

  const lastActivityMs = new Date(org.lastActivity).getTime();
  const overviewUpdatedMs = new Date(org.overview.updatedAt).getTime();
  const graceMs = graceDays * 24 * 60 * 60 * 1000;

  // Org's last activity is more than graceDays newer than the overview update
  return lastActivityMs > overviewUpdatedMs + graceMs;
}

/**
 * Filter a list of orgs (with overviews attached) to only those that are
 * stale by user-impact.
 */
export function filterStaleOrgs(
  orgs: OrgWithOverview[],
  opts: StaleFilterOpts = {},
): OrgWithOverview[] {
  return orgs.filter((org) => isOrgOverviewStale(org, opts));
}
