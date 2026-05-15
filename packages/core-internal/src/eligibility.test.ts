/**
 * Tests for fetchEligibleReleases.
 *
 * Coverage:
 * 1. Returns only rows where org.auto_generate_content = true
 * 2. Org-slug filter (orgSlugs) applies correctly
 * 3. Cutoff date bound excludes older releases
 * 4. Coverage-side rows are excluded (release_coverage.coverage_id IS NOT NULL)
 * 5. Suppressed releases are excluded
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { createTestDb, clearAllTables, type TestDatabase } from "../../../tests/db-helper.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
// Root src/ is 3 levels up from packages/core-internal/src/
import { releaseCoverage } from "../../../src/db/schema-coverage.js";
import { fetchEligibleReleases } from "./eligibility.js";

// Cast bun-sqlite TestDb to the DrizzleD1Database shape our helpers accept.
const asDb = (db: TestDatabase["db"]): any => db as any;

// ── Seed helpers ─────────────────────────────────────────────────────────────

function makeOrg(overrides: Partial<typeof organizations.$inferInsert> = {}) {
  return {
    id: "org_eligible_01",
    name: "Eligible Org",
    slug: "eligible-org",
    discovery: "curated" as const,
    autoGenerateContent: true,
    ...overrides,
  } satisfies typeof organizations.$inferInsert;
}

function makeSource(overrides: Partial<typeof sources.$inferInsert> = {}) {
  return {
    id: "src_eligible_01",
    name: "Eligible Source",
    slug: "eligible-source",
    type: "github" as const,
    url: "https://github.com/example/eligible",
    orgId: "org_eligible_01",
    discovery: "curated" as const,
    ...overrides,
  } satisfies typeof sources.$inferInsert;
}

function makeRelease(overrides: Partial<typeof releases.$inferInsert> = {}) {
  return {
    id: "rel_eligible_01",
    sourceId: "src_eligible_01",
    title: "Eligible Release",
    content: "This is real content that should be summarized.",
    publishedAt: "2026-05-01T00:00:00Z",
    fetchedAt: "2026-05-01T01:00:00Z",
    ...overrides,
  } satisfies typeof releases.$inferInsert;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("fetchEligibleReleases — org opt-in filter", () => {
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

  it("returns rows when org.auto_generate_content = true", async () => {
    tdb.db
      .insert(organizations)
      .values(makeOrg({ autoGenerateContent: true }))
      .run();
    tdb.db.insert(sources).values(makeSource()).run();
    tdb.db.insert(releases).values(makeRelease()).run();

    const rows = await fetchEligibleReleases(asDb(tdb.db), { cutoffIso: "2026-04-01T00:00:00Z" });
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe("rel_eligible_01");
  });

  it("excludes rows when org.auto_generate_content = false", async () => {
    tdb.db
      .insert(organizations)
      .values(makeOrg({ autoGenerateContent: false }))
      .run();
    tdb.db.insert(sources).values(makeSource()).run();
    tdb.db.insert(releases).values(makeRelease()).run();

    const rows = await fetchEligibleReleases(asDb(tdb.db), { cutoffIso: "2026-04-01T00:00:00Z" });
    expect(rows.length).toBe(0);
  });

  it("excludes rows when source.is_hidden = true", async () => {
    tdb.db
      .insert(organizations)
      .values(makeOrg({ autoGenerateContent: true }))
      .run();
    tdb.db
      .insert(sources)
      .values(makeSource({ isHidden: true }))
      .run();
    tdb.db.insert(releases).values(makeRelease()).run();

    const rows = await fetchEligibleReleases(asDb(tdb.db), { cutoffIso: "2026-04-01T00:00:00Z" });
    expect(rows.length).toBe(0);
  });
});

describe("fetchEligibleReleases — org slug filter", () => {
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

  it("returns all eligible rows when orgSlugs is null", async () => {
    // Seed two orgs, both opted in.
    for (const i of [1, 2]) {
      tdb.db
        .insert(organizations)
        .values(
          makeOrg({ id: `org_filter_0${i}`, slug: `org-filter-0${i}`, autoGenerateContent: true }),
        )
        .run();
      tdb.db
        .insert(sources)
        .values(
          makeSource({
            id: `src_filter_0${i}`,
            slug: `src-filter-0${i}`,
            orgId: `org_filter_0${i}`,
          }),
        )
        .run();
      tdb.db
        .insert(releases)
        .values(makeRelease({ id: `rel_filter_0${i}`, sourceId: `src_filter_0${i}` }))
        .run();
    }

    const rows = await fetchEligibleReleases(asDb(tdb.db), {
      cutoffIso: "2026-04-01T00:00:00Z",
      orgSlugs: null,
    });
    expect(rows.length).toBe(2);
  });

  it("filters to only the specified org slugs when orgSlugs is provided", async () => {
    for (const i of [1, 2]) {
      tdb.db
        .insert(organizations)
        .values(
          makeOrg({
            id: `org_slugfilter_0${i}`,
            slug: `org-slugfilter-0${i}`,
            autoGenerateContent: true,
          }),
        )
        .run();
      tdb.db
        .insert(sources)
        .values(
          makeSource({
            id: `src_slugfilter_0${i}`,
            slug: `src-slugfilter-0${i}`,
            orgId: `org_slugfilter_0${i}`,
          }),
        )
        .run();
      tdb.db
        .insert(releases)
        .values(makeRelease({ id: `rel_slugfilter_0${i}`, sourceId: `src_slugfilter_0${i}` }))
        .run();
    }

    const rows = await fetchEligibleReleases(asDb(tdb.db), {
      cutoffIso: "2026-04-01T00:00:00Z",
      orgSlugs: ["org-slugfilter-01"], // only first org
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe("rel_slugfilter_01");
  });
});

describe("fetchEligibleReleases — cutoff date bound", () => {
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

  it("excludes releases published before the cutoff", async () => {
    tdb.db
      .insert(organizations)
      .values(makeOrg({ autoGenerateContent: true }))
      .run();
    tdb.db.insert(sources).values(makeSource()).run();
    // Publish before the cutoff
    tdb.db
      .insert(releases)
      .values(
        makeRelease({ publishedAt: "2026-03-01T00:00:00Z", fetchedAt: "2026-03-01T00:00:00Z" }),
      )
      .run();

    const rows = await fetchEligibleReleases(asDb(tdb.db), {
      cutoffIso: "2026-04-01T00:00:00Z",
    });
    expect(rows.length).toBe(0);
  });

  it("includes releases published on the cutoff boundary (>=)", async () => {
    tdb.db
      .insert(organizations)
      .values(makeOrg({ autoGenerateContent: true }))
      .run();
    tdb.db.insert(sources).values(makeSource()).run();
    tdb.db
      .insert(releases)
      .values(
        makeRelease({ publishedAt: "2026-04-01T00:00:00Z", fetchedAt: "2026-04-01T00:00:00Z" }),
      )
      .run();

    const rows = await fetchEligibleReleases(asDb(tdb.db), {
      cutoffIso: "2026-04-01T00:00:00Z",
    });
    expect(rows.length).toBe(1);
  });
});

describe("fetchEligibleReleases — coverage-side exclusion", () => {
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

  it("excludes releases that are linked as coverage-side rows", async () => {
    tdb.db
      .insert(organizations)
      .values(makeOrg({ autoGenerateContent: true }))
      .run();
    tdb.db.insert(sources).values(makeSource()).run();

    // Canonical release
    tdb.db
      .insert(releases)
      .values(makeRelease({ id: "rel_canonical_01" }))
      .run();
    // Coverage-side release (what we're excluding)
    tdb.db
      .insert(releases)
      .values(makeRelease({ id: "rel_coverage_side_01", sourceId: "src_eligible_01" }))
      .run();

    // Link rel_coverage_side_01 as coverage of rel_canonical_01
    tdb.db
      .insert(releaseCoverage)
      .values({
        canonicalId: "rel_canonical_01",
        coverageId: "rel_coverage_side_01",
        reason: "test",
        decidedBy: "test",
        decidedAt: new Date().toISOString(),
      })
      .run();

    const rows = await fetchEligibleReleases(asDb(tdb.db), {
      cutoffIso: "2026-04-01T00:00:00Z",
    });

    // Only the canonical row should come back
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe("rel_canonical_01");
  });
});

describe("fetchEligibleReleases — global-newest across chunks (>90 orgs)", () => {
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

  it("returns the globally newest rows, not just newest per chunk", async () => {
    // Seed 91 orgs so the IN-clause must span two chunks (chunk size = 90).
    // The 91st org (last chunk) gets a release with the newest publishedAt;
    // all chunk-1 orgs get older releases. With maxRows=5, the result must
    // include org 91's release and not be dominated by chunk-1's newest rows.
    const ORG_COUNT = 91;
    const orgSlugs: string[] = [];

    for (let i = 1; i <= ORG_COUNT; i++) {
      const orgId = `org_chunk_${String(i).padStart(3, "0")}`;
      const srcId = `src_chunk_${String(i).padStart(3, "0")}`;
      const relId = `rel_chunk_${String(i).padStart(3, "0")}`;
      const slug = `org-chunk-${String(i).padStart(3, "0")}`;
      orgSlugs.push(slug);

      tdb.db
        .insert(organizations)
        .values(makeOrg({ id: orgId, slug, autoGenerateContent: true }))
        .run();
      tdb.db
        .insert(sources)
        .values(makeSource({ id: srcId, slug: `src-chunk-${String(i).padStart(3, "0")}`, orgId }))
        .run();

      // Org 91 (in the second chunk) gets the newest date; all others get older dates.
      const publishedAt =
        i === ORG_COUNT
          ? "2026-05-15T12:00:00Z" // newest — must appear in results
          : `2026-04-${String(i).padStart(2, "0")}T00:00:00Z`;

      tdb.db
        .insert(releases)
        .values(makeRelease({ id: relId, sourceId: srcId, publishedAt, fetchedAt: publishedAt }))
        .run();
    }

    const rows = await fetchEligibleReleases(asDb(tdb.db), {
      cutoffIso: "2026-04-01T00:00:00Z",
      orgSlugs,
      maxRows: 5,
    });

    expect(rows.length).toBe(5);
    // The globally newest release (org 91, second chunk) must be present.
    expect(rows[0]!.id).toBe("rel_chunk_091");
    // All returned rows must be in descending publishedAt order.
    for (let j = 1; j < rows.length; j++) {
      // Confirm ordering by checking the org index embedded in the id.
      const prev = rows[j - 1]!.id;
      const cur = rows[j]!.id;
      expect(prev >= cur).toBe(true);
    }
  });
});

describe("fetchEligibleReleases — suppressed exclusion", () => {
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

  it("excludes suppressed releases", async () => {
    tdb.db
      .insert(organizations)
      .values(makeOrg({ autoGenerateContent: true }))
      .run();
    tdb.db.insert(sources).values(makeSource()).run();
    tdb.db
      .insert(releases)
      .values(makeRelease({ suppressed: true }))
      .run();

    const rows = await fetchEligibleReleases(asDb(tdb.db), {
      cutoffIso: "2026-04-01T00:00:00Z",
    });
    expect(rows.length).toBe(0);
  });

  it("excludes already-summarized releases (title_short IS NOT NULL)", async () => {
    tdb.db
      .insert(organizations)
      .values(makeOrg({ autoGenerateContent: true }))
      .run();
    tdb.db.insert(sources).values(makeSource()).run();
    tdb.db
      .insert(releases)
      .values(makeRelease({ titleShort: "Already summarized" }))
      .run();

    const rows = await fetchEligibleReleases(asDb(tdb.db), {
      cutoffIso: "2026-04-01T00:00:00Z",
    });
    expect(rows.length).toBe(0);
  });
});
