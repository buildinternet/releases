/**
 * Tests for overview-eligibility.ts.
 *
 * Coverage:
 *   fetchOverviewCandidates
 *     - on_demand orgs excluded
 *     - autoGenerateContent=false excluded
 *     - org with no active sources excluded
 *     - missing overview + recent activity → eligible
 *     - missing overview + no recent activity → not eligible
 *     - existing overview, fresh (within minOverviewAgeDays) → not eligible
 *     - existing overview, old, but recentReleaseCount <= minNewReleases → not eligible
 *     - existing overview, old, recentReleaseCount > minNewReleases → eligible
 *     - orgSlugs filter narrows results
 *     - maxCandidates caps + most-stale-first ordering
 *
 *   fetchOverviewInputsForOrg
 *     - returns null for unknown org
 *     - empty `selected` when org has no active sources
 *     - hydrates org + sources + selected releases when present
 *     - existing overview content returned
 *     - releases outside windowDays excluded
 *     - suppressed releases excluded
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { createTestDb, clearAllTables, type TestDatabase } from "../../../tests/db-helper.js";
import {
  organizations,
  sources,
  releases,
  knowledgePages,
} from "@buildinternet/releases-core/schema";
import { fetchOverviewCandidates, fetchOverviewInputsForOrg } from "./overview-eligibility.js";

const asDb = (db: TestDatabase["db"]): any => db as any;

// ── seed helpers ────────────────────────────────────────────────────────────

function makeOrg(overrides: Partial<typeof organizations.$inferInsert> = {}) {
  return {
    id: "org_elig_01",
    name: "Eligibility Org",
    slug: "eligibility-org",
    discovery: "curated" as const,
    autoGenerateContent: true,
    ...overrides,
  } satisfies typeof organizations.$inferInsert;
}

function makeSource(overrides: Partial<typeof sources.$inferInsert> = {}) {
  return {
    id: "src_elig_01",
    name: "Eligibility Source",
    slug: "eligibility-source",
    type: "github" as const,
    url: "https://github.com/example/eligibility",
    orgId: "org_elig_01",
    discovery: "curated" as const,
    isHidden: false,
    fetchPriority: "normal" as const,
    ...overrides,
  } satisfies typeof sources.$inferInsert;
}

function makeRelease(overrides: Partial<typeof releases.$inferInsert> = {}) {
  return {
    id: "rel_elig_01",
    sourceId: "src_elig_01",
    title: "Eligibility Release",
    content: "body",
    publishedAt: "2026-05-01T00:00:00Z",
    fetchedAt: "2026-05-01T01:00:00Z",
    suppressed: false,
    ...overrides,
  } satisfies typeof releases.$inferInsert;
}

function makeOverview(overrides: Partial<typeof knowledgePages.$inferInsert> = {}) {
  return {
    id: "kp_elig_01",
    scope: "org" as const,
    orgId: "org_elig_01",
    content: "existing overview body",
    releaseCount: 5,
    lastContributingReleaseAt: "2026-04-01T00:00:00Z",
    generatedAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    ...overrides,
  } satisfies typeof knowledgePages.$inferInsert;
}

// `daysAgoIso(N)` in the function is `Date.now() - N * 86400000`. To make tests
// deterministic without freezing time, pick release/overview timestamps far
// enough from "now" that the relative ordering won't flip on test-clock drift.
const NOW_ISO = new Date().toISOString();
const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

// ── fetchOverviewCandidates ─────────────────────────────────────────────────

describe("fetchOverviewCandidates", () => {
  let tdb: TestDatabase;

  beforeAll(() => {
    tdb = createTestDb();
  });

  beforeEach(() => {
    clearAllTables(tdb.db);
  });

  afterAll(() => {
    tdb.cleanup();
  });

  it("excludes on_demand orgs", async () => {
    tdb.db
      .insert(organizations)
      .values(makeOrg({ discovery: "on_demand" }))
      .run();
    tdb.db.insert(sources).values(makeSource()).run();
    tdb.db
      .insert(releases)
      .values(makeRelease({ publishedAt: isoDaysAgo(1) }))
      .run();

    const out = await fetchOverviewCandidates(asDb(tdb.db));
    expect(out.length).toBe(0);
  });

  it("excludes orgs with autoGenerateContent=false", async () => {
    tdb.db
      .insert(organizations)
      .values(makeOrg({ autoGenerateContent: false }))
      .run();
    tdb.db.insert(sources).values(makeSource()).run();
    tdb.db
      .insert(releases)
      .values(makeRelease({ publishedAt: isoDaysAgo(1) }))
      .run();

    const out = await fetchOverviewCandidates(asDb(tdb.db));
    expect(out.length).toBe(0);
  });

  it("excludes orgs with no active sources", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    // No source row → INNER JOIN sources_active filters it out.

    const out = await fetchOverviewCandidates(asDb(tdb.db));
    expect(out.length).toBe(0);
  });

  it("excludes orgs whose only source is hidden", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db
      .insert(sources)
      .values(makeSource({ isHidden: true }))
      .run();
    tdb.db
      .insert(releases)
      .values(makeRelease({ publishedAt: isoDaysAgo(1) }))
      .run();

    const out = await fetchOverviewCandidates(asDb(tdb.db));
    expect(out.length).toBe(0);
  });

  it("excludes orgs whose only source is paused", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db
      .insert(sources)
      .values(makeSource({ fetchPriority: "paused" }))
      .run();
    tdb.db
      .insert(releases)
      .values(makeRelease({ publishedAt: isoDaysAgo(1) }))
      .run();

    const out = await fetchOverviewCandidates(asDb(tdb.db));
    expect(out.length).toBe(0);
  });

  it("includes orgs missing an overview when they have recent activity", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(sources).values(makeSource()).run();
    tdb.db
      .insert(releases)
      .values(makeRelease({ publishedAt: isoDaysAgo(1) }))
      .run();

    const out = await fetchOverviewCandidates(asDb(tdb.db));
    expect(out.length).toBe(1);
    expect(out[0]!.orgSlug).toBe("eligibility-org");
    expect(out[0]!.hasOverview).toBe(false);
    expect(out[0]!.overviewUpdatedAt).toBeNull();
    expect(out[0]!.recentReleaseCount).toBeGreaterThan(0);
  });

  it("excludes orgs missing an overview when no releases are in window", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(sources).values(makeSource()).run();
    tdb.db
      .insert(releases)
      .values(makeRelease({ publishedAt: isoDaysAgo(200) }))
      .run();

    const out = await fetchOverviewCandidates(asDb(tdb.db));
    expect(out.length).toBe(0);
  });

  it("excludes orgs with a fresh existing overview", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(sources).values(makeSource()).run();
    // Overview updated 1 day ago — well within the 14-day default threshold.
    tdb.db
      .insert(knowledgePages)
      .values(makeOverview({ updatedAt: isoDaysAgo(1) }))
      .run();
    // 30 brand-new releases since the overview's updated_at.
    const newReleases = Array.from({ length: 30 }, (_, i) => ({
      ...makeRelease({
        id: `rel_new_${i}`,
        publishedAt: NOW_ISO,
      }),
    }));
    tdb.db.insert(releases).values(newReleases).run();

    const out = await fetchOverviewCandidates(asDb(tdb.db));
    expect(out.length).toBe(0);
  });

  it("excludes orgs whose overview is old but recentReleaseCount is too low", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(sources).values(makeSource()).run();
    tdb.db
      .insert(knowledgePages)
      .values(makeOverview({ updatedAt: isoDaysAgo(60) }))
      .run();
    // Only 5 new releases — below the default minNewReleases=20.
    const newReleases = Array.from({ length: 5 }, (_, i) => ({
      ...makeRelease({
        id: `rel_new_${i}`,
        publishedAt: isoDaysAgo(30),
      }),
    }));
    tdb.db.insert(releases).values(newReleases).run();

    const out = await fetchOverviewCandidates(asDb(tdb.db));
    expect(out.length).toBe(0);
  });

  it("includes orgs whose overview is old AND recentReleaseCount exceeds threshold", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(sources).values(makeSource()).run();
    tdb.db
      .insert(knowledgePages)
      .values(makeOverview({ updatedAt: isoDaysAgo(60) }))
      .run();
    const newReleases = Array.from({ length: 25 }, (_, i) => ({
      ...makeRelease({
        id: `rel_new_${i}`,
        publishedAt: isoDaysAgo(30),
      }),
    }));
    tdb.db.insert(releases).values(newReleases).run();

    const out = await fetchOverviewCandidates(asDb(tdb.db));
    expect(out.length).toBe(1);
    expect(out[0]!.hasOverview).toBe(true);
    expect(out[0]!.recentReleaseCount).toBe(25);
  });

  it("orgSlugs filter narrows the candidate set", async () => {
    tdb.db
      .insert(organizations)
      .values([makeOrg({ id: "org_a", slug: "alpha" }), makeOrg({ id: "org_b", slug: "bravo" })])
      .run();
    tdb.db
      .insert(sources)
      .values([
        makeSource({ id: "src_a", slug: "src-alpha", orgId: "org_a" }),
        makeSource({ id: "src_b", slug: "src-bravo", orgId: "org_b" }),
      ])
      .run();
    tdb.db
      .insert(releases)
      .values([
        makeRelease({ id: "rel_a", sourceId: "src_a", publishedAt: isoDaysAgo(1) }),
        makeRelease({ id: "rel_b", sourceId: "src_b", publishedAt: isoDaysAgo(1) }),
      ])
      .run();

    const out = await fetchOverviewCandidates(asDb(tdb.db), { orgSlugs: ["alpha"] });
    expect(out.length).toBe(1);
    expect(out[0]!.orgSlug).toBe("alpha");
  });

  it("maxCandidates caps + sorts most-stale (highest recentReleaseCount) first", async () => {
    tdb.db
      .insert(organizations)
      .values([
        makeOrg({ id: "org_a", slug: "alpha" }),
        makeOrg({ id: "org_b", slug: "bravo" }),
        makeOrg({ id: "org_c", slug: "charlie" }),
      ])
      .run();
    tdb.db
      .insert(sources)
      .values([
        makeSource({ id: "src_a", slug: "src-alpha", orgId: "org_a" }),
        makeSource({ id: "src_b", slug: "src-bravo", orgId: "org_b" }),
        makeSource({ id: "src_c", slug: "src-charlie", orgId: "org_c" }),
      ])
      .run();
    // alpha: 5 releases, bravo: 20 releases, charlie: 10 releases.
    const rows: Array<typeof releases.$inferInsert> = [];
    for (let i = 0; i < 5; i++)
      rows.push(makeRelease({ id: `rel_a_${i}`, sourceId: "src_a", publishedAt: isoDaysAgo(1) }));
    for (let i = 0; i < 20; i++)
      rows.push(makeRelease({ id: `rel_b_${i}`, sourceId: "src_b", publishedAt: isoDaysAgo(1) }));
    for (let i = 0; i < 10; i++)
      rows.push(makeRelease({ id: `rel_c_${i}`, sourceId: "src_c", publishedAt: isoDaysAgo(1) }));
    tdb.db.insert(releases).values(rows).run();

    const out = await fetchOverviewCandidates(asDb(tdb.db), { maxCandidates: 2 });
    expect(out.length).toBe(2);
    expect(out[0]!.orgSlug).toBe("bravo"); // 20 releases
    expect(out[1]!.orgSlug).toBe("charlie"); // 10 releases
  });
});

// ── fetchOverviewInputsForOrg ───────────────────────────────────────────────

describe("fetchOverviewInputsForOrg", () => {
  let tdb: TestDatabase;

  beforeAll(() => {
    tdb = createTestDb();
  });

  beforeEach(() => {
    clearAllTables(tdb.db);
  });

  afterAll(() => {
    tdb.cleanup();
  });

  it("returns null for an unknown org", async () => {
    const out = await fetchOverviewInputsForOrg(asDb(tdb.db), "org_does_not_exist");
    expect(out).toBeNull();
  });

  it("returns empty selected when the org has no active sources", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();

    const out = await fetchOverviewInputsForOrg(asDb(tdb.db), "org_elig_01");
    expect(out).not.toBeNull();
    expect(out!.sources.length).toBe(0);
    expect(out!.selected.length).toBe(0);
    expect(out!.totalAvailable).toBe(0);
    expect(out!.existingContent).toBeNull();
  });

  it("hydrates org + sources + recent releases", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(sources).values(makeSource()).run();
    tdb.db
      .insert(releases)
      .values([
        makeRelease({ id: "rel_1", publishedAt: isoDaysAgo(2) }),
        makeRelease({ id: "rel_2", publishedAt: isoDaysAgo(5) }),
        makeRelease({ id: "rel_3", publishedAt: isoDaysAgo(10) }),
      ])
      .run();

    const out = await fetchOverviewInputsForOrg(asDb(tdb.db), "org_elig_01");
    expect(out).not.toBeNull();
    expect(out!.org.slug).toBe("eligibility-org");
    expect(out!.sources.length).toBe(1);
    expect(out!.selected.length).toBe(3);
    expect(out!.totalAvailable).toBe(3);
    // sorted desc by publishedAt by selectReleasesForOverview
    expect(out!.selected[0]!.id).toBe("rel_1");
  });

  it("returns existing overview content when present", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(sources).values(makeSource()).run();
    tdb.db
      .insert(releases)
      .values(makeRelease({ publishedAt: isoDaysAgo(1) }))
      .run();
    tdb.db.insert(knowledgePages).values(makeOverview()).run();

    const out = await fetchOverviewInputsForOrg(asDb(tdb.db), "org_elig_01");
    expect(out!.existingContent).toBe("existing overview body");
  });

  it("excludes releases outside the lookback window", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(sources).values(makeSource()).run();
    tdb.db
      .insert(releases)
      .values([
        makeRelease({ id: "rel_recent", publishedAt: isoDaysAgo(1) }),
        makeRelease({ id: "rel_old", publishedAt: isoDaysAgo(200) }),
      ])
      .run();

    const out = await fetchOverviewInputsForOrg(asDb(tdb.db), "org_elig_01");
    expect(out!.selected.length).toBe(1);
    expect(out!.selected[0]!.id).toBe("rel_recent");
  });

  it("excludes suppressed releases", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(sources).values(makeSource()).run();
    tdb.db
      .insert(releases)
      .values([
        makeRelease({ id: "rel_visible", publishedAt: isoDaysAgo(1), suppressed: false }),
        makeRelease({ id: "rel_suppressed", publishedAt: isoDaysAgo(2), suppressed: true }),
      ])
      .run();

    const out = await fetchOverviewInputsForOrg(asDb(tdb.db), "org_elig_01");
    expect(out!.selected.length).toBe(1);
    expect(out!.selected[0]!.id).toBe("rel_visible");
  });
});
