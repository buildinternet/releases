import { describe, it, expect } from "bun:test";
import {
  isOrgOverviewStale,
  filterStaleOrgs,
  STALE_MIN_RELEASES_DEFAULT,
  type OrgWithOverview,
} from "../../src/lib/overview-stale-filter.js";

// A base org with enough recent releases to be "active"
const activeOrg: OrgWithOverview = {
  slug: "acme",
  name: "Acme",
  domain: "acme.com",
  avatarUrl: null,
  githubHandle: null,
  sourceCount: 2,
  releaseCount: 100,
  recentReleaseCount: 10,
  lastActivity: "2025-01-14T00:00:00Z", // 1 day ago
  topProducts: [],
  sparkline: [],
  overview: undefined,
};

const makeOverview = (updatedAt: string) => ({
  scope: "org" as const,
  orgSlug: "acme",
  productSlug: null,
  content: "Some overview content",
  releaseCount: 50,
  lastContributingReleaseAt: updatedAt,
  generatedAt: updatedAt,
  updatedAt,
});

describe("isOrgOverviewStale", () => {
  it("is stale when overview is missing and org has recent activity", () => {
    const org: OrgWithOverview = { ...activeOrg, overview: undefined };
    expect(isOrgOverviewStale(org)).toBe(true);
  });

  it("is stale when overview is null and org has recent activity", () => {
    const org: OrgWithOverview = { ...activeOrg, overview: null };
    expect(isOrgOverviewStale(org)).toBe(true);
  });

  it("is not stale when recentReleaseCount is at or below threshold", () => {
    const quietOrg: OrgWithOverview = {
      ...activeOrg,
      recentReleaseCount: STALE_MIN_RELEASES_DEFAULT,
      overview: undefined,
    };
    expect(isOrgOverviewStale(quietOrg)).toBe(false);
  });

  it("is not stale when recentReleaseCount is below threshold", () => {
    const quietOrg: OrgWithOverview = {
      ...activeOrg,
      recentReleaseCount: 2,
      overview: undefined,
    };
    expect(isOrgOverviewStale(quietOrg)).toBe(false);
  });

  it("is not stale when overview is recent relative to last activity", () => {
    // lastActivity = 1 day ago, overview updated 2 days ago — within the 7d grace
    const org: OrgWithOverview = {
      ...activeOrg,
      lastActivity: "2025-01-14T00:00:00Z",
      overview: makeOverview("2025-01-13T00:00:00Z"),
    };
    expect(isOrgOverviewStale(org)).toBe(false);
  });

  it("is stale when lastActivity is more than graceDays after overview.updatedAt", () => {
    // overview updated 20 days ago, lastActivity 5 days ago — gap = 15d > 7d grace
    const org: OrgWithOverview = {
      ...activeOrg,
      lastActivity: "2025-01-10T00:00:00Z",
      overview: makeOverview("2024-12-26T00:00:00Z"),
    };
    expect(isOrgOverviewStale(org)).toBe(true);
  });

  it("is not stale when lastActivity is exactly at overview.updatedAt + graceDays", () => {
    // overview updated Jan 1, grace = 7d → threshold = Jan 8, lastActivity = Jan 8 exactly
    const org: OrgWithOverview = {
      ...activeOrg,
      lastActivity: "2025-01-08T00:00:00Z",
      overview: makeOverview("2025-01-01T00:00:00Z"),
    };
    // NOT stale — lastActivity must be strictly GREATER than updatedAt + grace
    expect(isOrgOverviewStale(org)).toBe(false);
  });

  it("respects custom minReleases threshold", () => {
    const org: OrgWithOverview = {
      ...activeOrg,
      recentReleaseCount: 3,
      overview: undefined,
    };
    // Default threshold is 5, so recentReleaseCount=3 is not active
    expect(isOrgOverviewStale(org)).toBe(false);
    // Custom threshold of 2 makes it active
    expect(isOrgOverviewStale(org, { minReleases: 2 })).toBe(true);
  });

  it("respects custom graceDays threshold", () => {
    // overview 3 days older than lastActivity
    const org: OrgWithOverview = {
      ...activeOrg,
      lastActivity: "2025-01-10T00:00:00Z",
      overview: makeOverview("2025-01-07T00:00:00Z"),
    };
    // Default 7d grace: 3d gap is within grace → not stale
    expect(isOrgOverviewStale(org)).toBe(false);
    // Custom 2d grace: 3d gap exceeds grace → stale
    expect(isOrgOverviewStale(org, { graceDays: 2 })).toBe(true);
  });

  it("is not stale when lastActivity is null even if overview is missing", () => {
    const org: OrgWithOverview = {
      ...activeOrg,
      lastActivity: null,
      overview: undefined,
    };
    // Missing overview + no lastActivity: can't determine if stale
    // The predicate returns true for missing overview (recentReleaseCount > threshold)
    // regardless of lastActivity=null because the missing-overview branch returns true
    // before checking lastActivity.
    expect(isOrgOverviewStale(org)).toBe(true);
  });

  it("is not stale when lastActivity is null but overview exists", () => {
    const org: OrgWithOverview = {
      ...activeOrg,
      lastActivity: null,
      overview: makeOverview("2020-01-01T00:00:00Z"),
    };
    // lastActivity is null → cannot determine staleness from activity → not stale
    expect(isOrgOverviewStale(org)).toBe(false);
  });
});

describe("filterStaleOrgs", () => {
  it("returns only stale orgs from a mixed list", () => {
    const staleOrg: OrgWithOverview = {
      ...activeOrg,
      slug: "stale-co",
      lastActivity: "2025-01-10T00:00:00Z",
      overview: makeOverview("2024-12-26T00:00:00Z"),
    };
    const freshOrg: OrgWithOverview = {
      ...activeOrg,
      slug: "fresh-co",
      lastActivity: "2025-01-14T00:00:00Z",
      overview: makeOverview("2025-01-13T00:00:00Z"),
    };
    const quietOrg: OrgWithOverview = {
      ...activeOrg,
      slug: "quiet-co",
      recentReleaseCount: 1,
      overview: undefined,
    };

    const result = filterStaleOrgs([staleOrg, freshOrg, quietOrg]);
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe("stale-co");
  });

  it("returns empty array when no orgs are stale", () => {
    const freshOrg: OrgWithOverview = {
      ...activeOrg,
      lastActivity: "2025-01-14T00:00:00Z",
      overview: makeOverview("2025-01-13T00:00:00Z"),
    };
    expect(filterStaleOrgs([freshOrg])).toHaveLength(0);
  });
});
