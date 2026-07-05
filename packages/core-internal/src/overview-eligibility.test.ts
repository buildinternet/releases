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
 *     - explicit orgSlugs bypasses age threshold (fresh overview still returned)
 *     - explicit orgSlugs bypasses minNewReleases threshold (1 release is enough)
 *     - explicit orgSlugs still excludes orgs with recentReleaseCount=0
 *     - force + explicit orgSlugs regenerates a recentReleaseCount=0 org
 *     - force is inert without an explicit orgSlugs list
 *     - explicit orgSlugs still restricts to listed orgs (IN-clause preserved)
 *
 *   fetchOverviewInputsForOrg
 *     - returns null for unknown org
 *     - empty `selected` when org has no active sources
 *     - hydrates org + sources + selected releases when present
 *     - existing overview content returned
 *     - releases outside windowDays excluded
 *     - suppressed releases excluded
 *     - active org (>=5 releases in 30d) selects only the 30d slice
 *     - quiet org (releases only ~60d out) widens to the 90d fallback
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
    // Overview updated 1 day ago — well within the 7-day default threshold.
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

  it("default age threshold is weekly: an 8-day-old overview with new activity is eligible", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(sources).values(makeSource()).run();
    // 8 days old — past the 7-day default, but would have been fresh under the old 14-day gate.
    tdb.db
      .insert(knowledgePages)
      .values(makeOverview({ updatedAt: isoDaysAgo(8) }))
      .run();
    // One new release since the overview — enough for the cron's minNewReleases:0 gate.
    tdb.db
      .insert(releases)
      .values(makeRelease({ publishedAt: isoDaysAgo(1) }))
      .run();

    const out = await fetchOverviewCandidates(asDb(tdb.db), { minNewReleases: 0 });
    expect(out.length).toBe(1);
    expect(out[0]!.orgSlug).toBe("eligibility-org");
  });

  it("velocity fast tier: a 3-day-old overview qualifies when release velocity is high (#1895)", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(sources).values(makeSource()).run();
    // 3 days old — fresh under the 7-day default, past the 2-day fast tier.
    tdb.db
      .insert(knowledgePages)
      .values(makeOverview({ updatedAt: isoDaysAgo(3) }))
      .run();
    // 20 new releases ≥ the fast-tier threshold (15).
    const newReleases = Array.from({ length: 20 }, (_, i) =>
      makeRelease({ id: `rel_fast_${i}`, publishedAt: isoDaysAgo(1) }),
    );
    tdb.db.insert(releases).values(newReleases).run();

    const out = await fetchOverviewCandidates(asDb(tdb.db), { minNewReleases: 0 });
    expect(out.length).toBe(1);
    expect(out[0]!.recentReleaseCount).toBe(20);
    expect(out[0]!.overviewCadenceDays).toBeNull();
  });

  it("velocity fast tier: a 3-day-old overview at low velocity stays on the 7-day default", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(sources).values(makeSource()).run();
    tdb.db
      .insert(knowledgePages)
      .values(makeOverview({ updatedAt: isoDaysAgo(3) }))
      .run();
    // 5 new releases — under the fast-tier threshold (15).
    const newReleases = Array.from({ length: 5 }, (_, i) =>
      makeRelease({ id: `rel_slow_${i}`, publishedAt: isoDaysAgo(1) }),
    );
    tdb.db.insert(releases).values(newReleases).run();

    const out = await fetchOverviewCandidates(asDb(tdb.db), { minNewReleases: 0 });
    expect(out.length).toBe(0);
  });

  it("fast-tier thresholds are tunable via options", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(sources).values(makeSource()).run();
    tdb.db
      .insert(knowledgePages)
      .values(makeOverview({ updatedAt: isoDaysAgo(3) }))
      .run();
    const newReleases = Array.from({ length: 5 }, (_, i) =>
      makeRelease({ id: `rel_tune_${i}`, publishedAt: isoDaysAgo(1) }),
    );
    tdb.db.insert(releases).values(newReleases).run();

    // Same 5-release org qualifies once the fast tier is tuned down to its level.
    const out = await fetchOverviewCandidates(asDb(tdb.db), {
      minNewReleases: 0,
      fastMinReleases: 5,
      fastCadenceDays: 2,
    });
    expect(out.length).toBe(1);
  });

  it("per-org override pins a slower cadence: 14d override beats the fast tier (#1895)", async () => {
    // The bursty-SDK case: high velocity from one publish event must NOT
    // accelerate an org pinned to a slower cadence.
    tdb.db
      .insert(organizations)
      .values(makeOrg({ overviewCadenceDays: 14 }))
      .run();
    tdb.db.insert(sources).values(makeSource()).run();
    tdb.db
      .insert(knowledgePages)
      .values(makeOverview({ updatedAt: isoDaysAgo(8) }))
      .run();
    const newReleases = Array.from({ length: 30 }, (_, i) =>
      makeRelease({ id: `rel_burst_${i}`, publishedAt: isoDaysAgo(1) }),
    );
    tdb.db.insert(releases).values(newReleases).run();

    const out = await fetchOverviewCandidates(asDb(tdb.db), { minNewReleases: 0 });
    expect(out.length).toBe(0);
  });

  it("per-org override pins a faster cadence: 1d override with a 2-day-old overview is eligible", async () => {
    tdb.db
      .insert(organizations)
      .values(makeOrg({ overviewCadenceDays: 1 }))
      .run();
    tdb.db.insert(sources).values(makeSource()).run();
    tdb.db
      .insert(knowledgePages)
      .values(makeOverview({ updatedAt: isoDaysAgo(2) }))
      .run();
    tdb.db
      .insert(releases)
      .values(makeRelease({ publishedAt: isoDaysAgo(1) }))
      .run();

    const out = await fetchOverviewCandidates(asDb(tdb.db), { minNewReleases: 0 });
    expect(out.length).toBe(1);
    expect(out[0]!.overviewCadenceDays).toBe(1);
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

  it("explicit orgSlugs bypasses age threshold — fresh overview (1 day old) is still returned", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(sources).values(makeSource()).run();
    // Overview updated 1 day ago — well within the default 7-day age threshold.
    tdb.db
      .insert(knowledgePages)
      .values(makeOverview({ updatedAt: isoDaysAgo(1) }))
      .run();
    // Only 1 new release since the overview — below the default minNewReleases=20.
    tdb.db
      .insert(releases)
      .values(makeRelease({ publishedAt: isoDaysAgo(0) }))
      .run();

    // Without orgSlugs the age + min-release thresholds would filter this org out.
    const withoutOrgSlugs = await fetchOverviewCandidates(asDb(tdb.db));
    expect(withoutOrgSlugs.length).toBe(0); // confirms the default predicate rejects it

    // With an explicit allowlist both thresholds are bypassed.
    const out = await fetchOverviewCandidates(asDb(tdb.db), {
      orgSlugs: ["eligibility-org"],
    });
    expect(out.length).toBe(1);
    expect(out[0]!.orgSlug).toBe("eligibility-org");
  });

  it("explicit orgSlugs bypasses minNewReleases — 1 new release is sufficient", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(sources).values(makeSource()).run();
    // Overview is 60 days old (well past the 7-day age threshold) but only
    // 1 new release — below default minNewReleases=20.
    tdb.db
      .insert(knowledgePages)
      .values(makeOverview({ updatedAt: isoDaysAgo(60) }))
      .run();
    tdb.db
      .insert(releases)
      .values(makeRelease({ publishedAt: isoDaysAgo(30) }))
      .run();

    const withoutOrgSlugs = await fetchOverviewCandidates(asDb(tdb.db));
    expect(withoutOrgSlugs.length).toBe(0); // min-release threshold blocks it

    const out = await fetchOverviewCandidates(asDb(tdb.db), {
      orgSlugs: ["eligibility-org"],
    });
    expect(out.length).toBe(1);
    expect(out[0]!.recentReleaseCount).toBe(1);
  });

  it("explicit orgSlugs still excludes orgs with recentReleaseCount=0", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(sources).values(makeSource()).run();
    // Overview updated today; no releases newer than the overview.
    tdb.db
      .insert(knowledgePages)
      .values(makeOverview({ updatedAt: isoDaysAgo(0) }))
      .run();
    // All releases are older than the overview's updatedAt — recentReleaseCount=0.
    tdb.db
      .insert(releases)
      .values(makeRelease({ publishedAt: isoDaysAgo(30) }))
      .run();

    const out = await fetchOverviewCandidates(asDb(tdb.db), {
      orgSlugs: ["eligibility-org"],
    });
    expect(out.length).toBe(0);
  });

  it("force + explicit orgSlugs regenerates an org with recentReleaseCount=0", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(sources).values(makeSource()).run();
    // Overview updated today; every release predates it → recentReleaseCount=0.
    tdb.db
      .insert(knowledgePages)
      .values(makeOverview({ updatedAt: isoDaysAgo(0) }))
      .run();
    tdb.db
      .insert(releases)
      .values(makeRelease({ publishedAt: isoDaysAgo(30) }))
      .run();

    // Without force the recentReleaseCount=0 guard rejects it (baseline).
    const withoutForce = await fetchOverviewCandidates(asDb(tdb.db), {
      orgSlugs: ["eligibility-org"],
    });
    expect(withoutForce.length).toBe(0);

    // force lifts that guard for the explicit re-run (e.g. after a gen fix).
    const out = await fetchOverviewCandidates(asDb(tdb.db), {
      orgSlugs: ["eligibility-org"],
      force: true,
    });
    expect(out.length).toBe(1);
    expect(out[0]!.orgSlug).toBe("eligibility-org");
    expect(out[0]!.recentReleaseCount).toBe(0);
  });

  it("force is inert without an explicit orgSlugs list (never fans out to every org)", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(sources).values(makeSource()).run();
    tdb.db
      .insert(knowledgePages)
      .values(makeOverview({ updatedAt: isoDaysAgo(0) }))
      .run();
    tdb.db
      .insert(releases)
      .values(makeRelease({ publishedAt: isoDaysAgo(30) }))
      .run();

    // force with no orgSlugs must not bypass the default predicate.
    const out = await fetchOverviewCandidates(asDb(tdb.db), { force: true });
    expect(out.length).toBe(0);
  });

  it("minNewReleases:0 makes a stale overview with >=1 new release eligible (the cron's staleness gate)", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(sources).values(makeSource()).run();
    // Overview 60 days old, only 1 new release — rejected by the default 20.
    tdb.db
      .insert(knowledgePages)
      .values(makeOverview({ updatedAt: isoDaysAgo(60) }))
      .run();
    tdb.db
      .insert(releases)
      .values(makeRelease({ publishedAt: isoDaysAgo(30) }))
      .run();

    // Default threshold (20) rejects it.
    expect((await fetchOverviewCandidates(asDb(tdb.db))).length).toBe(0);

    // minNewReleases:0 (the OverviewRegenWorkflow setting) accepts it: stale + >=1 new release.
    const out = await fetchOverviewCandidates(asDb(tdb.db), { minNewReleases: 0 });
    expect(out.length).toBe(1);
    expect(out[0]!.orgSlug).toBe("eligibility-org");
  });

  it("minNewReleases:0 still rejects a stale overview with ZERO new releases", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(sources).values(makeSource()).run();
    // Overview 60 days old; the only release predates it — recentReleaseCount=0.
    tdb.db
      .insert(knowledgePages)
      .values(makeOverview({ updatedAt: isoDaysAgo(60) }))
      .run();
    tdb.db
      .insert(releases)
      .values(makeRelease({ publishedAt: isoDaysAgo(90) }))
      .run();

    // `recentReleaseCount > 0` is still required, so nothing-changed orgs aren't regenerated.
    expect((await fetchOverviewCandidates(asDb(tdb.db), { minNewReleases: 0 })).length).toBe(0);
  });

  it("explicit orgSlugs still restricts to listed orgs (IN-clause preserved)", async () => {
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
    // Both orgs have 1 new release (would be blocked by minNewReleases without orgSlugs).
    tdb.db
      .insert(releases)
      .values([
        makeRelease({ id: "rel_a", sourceId: "src_a", publishedAt: isoDaysAgo(1) }),
        makeRelease({ id: "rel_b", sourceId: "src_b", publishedAt: isoDaysAgo(1) }),
      ])
      .run();

    // Only list "alpha" — "bravo" must not appear even though it would otherwise qualify.
    const out = await fetchOverviewCandidates(asDb(tdb.db), { orgSlugs: ["alpha"] });
    expect(out.length).toBe(1);
    expect(out[0]!.orgSlug).toBe("alpha");
  });

  it("orgSlugs filter handles >90 slugs via OR-merged IN-clause chunks", async () => {
    // IN_CLAUSE_CHUNK = 90, so 91 forces the two-chunk OR-merge branch.
    const N = 91;
    const orgRows = Array.from({ length: N }, (_, i) =>
      makeOrg({ id: `org_chunk_${i}`, slug: `slug-chunk-${i}` }),
    );
    const sourceRows = Array.from({ length: N }, (_, i) =>
      makeSource({ id: `src_chunk_${i}`, slug: `src-chunk-${i}`, orgId: `org_chunk_${i}` }),
    );
    const releaseRows = Array.from({ length: N }, (_, i) =>
      makeRelease({ id: `rel_chunk_${i}`, sourceId: `src_chunk_${i}`, publishedAt: isoDaysAgo(1) }),
    );
    tdb.db.insert(organizations).values(orgRows).run();
    tdb.db.insert(sources).values(sourceRows).run();
    tdb.db.insert(releases).values(releaseRows).run();

    const slugs = orgRows.map((o) => o.slug);
    const out = await fetchOverviewCandidates(asDb(tdb.db), {
      orgSlugs: slugs,
      maxCandidates: N,
    });
    expect(out.length).toBe(N);
    const returned = out.map((c) => c.orgSlug);
    expect(new Set(returned).size).toBe(N); // chunk merge produced no duplicates
    for (const s of returned) expect(slugs).toContain(s);
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

  it("reports existing overview content even when the org has no active sources", async () => {
    // Org with a stored overview but every source hidden/paused/removed: the
    // existing content must still surface (the empty-sources early return reads
    // knowledge_pages before bailing), so `GET …/overview/inputs` keeps its
    // pre-delegation behavior.
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(knowledgePages).values(makeOverview()).run();

    const out = await fetchOverviewInputsForOrg(asDb(tdb.db), "org_elig_01");
    expect(out).not.toBeNull();
    expect(out!.sources.length).toBe(0);
    expect(out!.selected.length).toBe(0);
    expect(out!.existingContent).toBe("existing overview body");
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

  it("returns all rows when source count exceeds the inArray chunk size", async () => {
    // IN_CLAUSE_CHUNK = 90, so 100 sources/releases forces multi-chunk SELECT
    // via the OR-merged inArray(...) branch in fetchOverviewInputsForOrg.
    const N = 100;
    tdb.db.insert(organizations).values(makeOrg()).run();
    const sourceRows = Array.from({ length: N }, (_, i) =>
      makeSource({ id: `src_chunk_${i}`, slug: `src-chunk-${i}` }),
    );
    tdb.db.insert(sources).values(sourceRows).run();
    // Keep every release inside the 30-day window so totalAvailable can prove
    // the chunked SELECT didn't drop rows. Spread within 1..20 days for
    // deterministic ordering downstream.
    const releaseRows = Array.from({ length: N }, (_, i) =>
      makeRelease({
        id: `rel_chunk_${i}`,
        sourceId: `src_chunk_${i}`,
        publishedAt: isoDaysAgo((i % 20) + 1),
      }),
    );
    tdb.db.insert(releases).values(releaseRows).run();

    const out = await fetchOverviewInputsForOrg(asDb(tdb.db), "org_elig_01");
    expect(out).not.toBeNull();
    expect(out!.sources.length).toBe(N);
    // The chunked SELECT must surface every row; totalAvailable is the proof.
    // (selected is post-budget capped by selectReleasesForOverview.)
    expect(out!.totalAvailable).toBe(N);
    expect(out!.selected.length).toBeGreaterThan(0);
    const selectedIds = new Set(out!.selected.map((r) => r.id));
    for (const id of selectedIds) expect(id.startsWith("rel_chunk_")).toBe(true);
  });

  it("active org with >=5 releases inside 30d selects only the 30d slice (no fallback)", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(sources).values(makeSource()).run();
    tdb.db
      .insert(releases)
      .values([
        // 6 releases within the 30-day window.
        ...Array.from({ length: 6 }, (_, i) =>
          makeRelease({ id: `rel_recent_${i}`, publishedAt: isoDaysAgo(i + 1) }),
        ),
        // A release well outside even the 90-day fallback — must never appear.
        makeRelease({ id: "rel_ancient", publishedAt: isoDaysAgo(200) }),
      ])
      .run();

    const out = await fetchOverviewInputsForOrg(asDb(tdb.db), "org_elig_01");
    expect(out).not.toBeNull();
    expect(out!.windowDays).toBe(30);
    expect(out!.selected.length).toBe(6);
    expect(out!.totalAvailable).toBe(6);
    const ids = out!.selected.map((r) => r.id);
    expect(ids).not.toContain("rel_ancient");
  });

  it("quiet org with releases only ~60d out widens to the 90d fallback", async () => {
    tdb.db.insert(organizations).values(makeOrg()).run();
    tdb.db.insert(sources).values(makeSource()).run();
    // No releases inside 30d; a handful around 60 days out — below
    // OVERVIEW_MIN_WINDOW_RELEASES at the default window, so the 30d slice
    // alone would be empty and the fallback should widen to 90d.
    tdb.db
      .insert(releases)
      .values(
        Array.from({ length: 3 }, (_, i) =>
          makeRelease({ id: `rel_quiet_${i}`, publishedAt: isoDaysAgo(60 + i) }),
        ),
      )
      .run();

    const out = await fetchOverviewInputsForOrg(asDb(tdb.db), "org_elig_01");
    expect(out).not.toBeNull();
    expect(out!.windowDays).toBe(90);
    expect(out!.selected.length).toBe(3);
    expect(out!.totalAvailable).toBe(3);
  });
});
