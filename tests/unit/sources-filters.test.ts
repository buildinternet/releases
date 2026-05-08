/**
 * Unit tests for the new server-side `?type=` and `?stale=` filters wired
 * through `getSourcesWithStats` / `countSourcesForList`. Status dashboard
 * paging (#735) depends on these filters being applied at the DB layer.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import {
  organizations,
  sources,
  releases,
  sourceChangelogFiles,
} from "@buildinternet/releases-core/schema";
import {
  countSourcesForList,
  getSourcesWithStats,
  SOURCE_STALE_DAYS,
} from "../../workers/api/src/queries/sources.js";

let tdb: TestDatabase;

const STALE_ISO = new Date(Date.now() - (SOURCE_STALE_DAYS + 5) * 86400_000).toISOString();
const FRESH_ISO = new Date(Date.now() - 1 * 86400_000).toISOString();

beforeAll(async () => {
  tdb = createTestDb();
  const db = tdb.db;

  await db.insert(organizations).values([
    { id: "org_a", name: "Org A", slug: "org-a" },
    { id: "org_b", name: "Org B", slug: "org-b" },
  ]);

  await db.insert(sources).values([
    // Fresh github
    { id: "src_1", orgId: "org_a", name: "A1", slug: "a1", type: "github", url: "https://a/1" },
    // Stale feed (latest release > 90d)
    { id: "src_2", orgId: "org_a", name: "A2", slug: "a2", type: "feed", url: "https://a/2" },
    // Never-released scrape (counts as stale)
    { id: "src_3", orgId: "org_b", name: "B1", slug: "b1", type: "scrape", url: "https://b/1" },
    // Fresh scrape
    { id: "src_4", orgId: "org_b", name: "B2", slug: "b2", type: "scrape", url: "https://b/2" },
    // Fresh agent
    { id: "src_5", orgId: "org_b", name: "B3", slug: "b3", type: "agent", url: "https://b/3" },
  ]);

  await db.insert(releases).values([
    {
      id: "rel_1",
      sourceId: "src_1",
      title: "fresh",
      content: "x",
      url: "https://a/1/r/1",
      publishedAt: FRESH_ISO,
    },
    {
      id: "rel_2",
      sourceId: "src_2",
      title: "stale",
      content: "x",
      url: "https://a/2/r/1",
      publishedAt: STALE_ISO,
    },
    {
      id: "rel_4",
      sourceId: "src_4",
      title: "fresh",
      content: "x",
      url: "https://b/2/r/1",
      publishedAt: FRESH_ISO,
    },
    {
      id: "rel_5",
      sourceId: "src_5",
      title: "fresh",
      content: "x",
      url: "https://b/3/r/1",
      publishedAt: FRESH_ISO,
    },
  ]);
});

afterAll(() => tdb.cleanup());

describe("?type filter", () => {
  it("countSourcesForList narrows to a single type via whereClause", async () => {
    const count = await countSourcesForList(tdb.db as never, eq(sources.type, "scrape"));
    expect(count).toBe(2);
  });

  it("getSourcesWithStats narrows to a single type via whereClause", async () => {
    const rows = await getSourcesWithStats(tdb.db as never, eq(sources.type, "github"));
    expect(rows.map((r) => r.id)).toEqual(["src_1"]);
  });
});

describe("?stale filter (staleOnly)", () => {
  it("countSourcesForList includes never-released sources as stale", async () => {
    const count = await countSourcesForList(tdb.db as never, undefined, { staleOnly: true });
    // src_2 (latestDate < cutoff) + src_3 (no releases) = 2
    expect(count).toBe(2);
  });

  it("getSourcesWithStats returns only stale rows when staleOnly is set", async () => {
    const rows = await getSourcesWithStats(tdb.db as never, undefined, { staleOnly: true });
    const ids = rows.map((r) => r.id).toSorted();
    expect(ids).toEqual(["src_2", "src_3"]);
  });

  it("staleOnly composes with whereClause", async () => {
    // org_b stale = src_3 only
    const rows = await getSourcesWithStats(tdb.db as never, eq(sources.orgId, "org_b"), {
      staleOnly: true,
    });
    expect(rows.map((r) => r.id)).toEqual(["src_3"]);
    const count = await countSourcesForList(tdb.db as never, eq(sources.orgId, "org_b"), {
      staleOnly: true,
    });
    expect(count).toBe(1);
  });

  it("staleOnly=false returns all rows", async () => {
    const count = await countSourcesForList(tdb.db as never, undefined, { staleOnly: false });
    expect(count).toBe(5);
  });
});

describe("missingChangelog filter (?hasChangelog=false)", () => {
  beforeAll(async () => {
    await tdb.db.insert(sourceChangelogFiles).values([
      {
        id: "scf_1",
        sourceId: "src_1",
        path: "CHANGELOG.md",
        filename: "CHANGELOG.md",
        url: "https://example/1",
        rawUrl: "https://example/1/raw",
        content: "x",
        contentHash: "h1",
        bytes: 1,
      },
      {
        id: "scf_4",
        sourceId: "src_4",
        path: "CHANGELOG.md",
        filename: "CHANGELOG.md",
        url: "https://example/4",
        rawUrl: "https://example/4/raw",
        content: "x",
        contentHash: "h4",
        bytes: 1,
      },
    ]);
  });

  it("returns only sources with no row in source_changelog_files", async () => {
    const rows = await getSourcesWithStats(tdb.db as never, undefined, {
      missingChangelog: true,
    });
    expect(rows.map((r) => r.id).toSorted()).toEqual(["src_2", "src_3", "src_5"]);
  });

  it("counts only sources missing a changelog", async () => {
    const count = await countSourcesForList(tdb.db as never, undefined, { missingChangelog: true });
    expect(count).toBe(3);
  });
});

describe("minReleasesLast30Days filter (?minRels30d)", () => {
  beforeAll(async () => {
    // src_5 has FRESH_ISO release already; add 2 more to put it at 3 total in 30d.
    await tdb.db.insert(releases).values([
      {
        id: "rel_5b",
        sourceId: "src_5",
        title: "fresh-b",
        content: "x",
        url: "https://b/3/r/2",
        publishedAt: FRESH_ISO,
      },
      {
        id: "rel_5c",
        sourceId: "src_5",
        title: "fresh-c",
        content: "x",
        url: "https://b/3/r/3",
        publishedAt: FRESH_ISO,
      },
    ]);
  });

  it("filters out sources below the threshold", async () => {
    const rows = await getSourcesWithStats(tdb.db as never, undefined, {
      minReleasesLast30Days: 3,
    });
    expect(rows.map((r) => r.id)).toEqual(["src_5"]);
  });

  it("composes with missingChangelog", async () => {
    // src_5 has 3+ releases in last 30d AND no changelog row → it's the only hit.
    const rows = await getSourcesWithStats(tdb.db as never, undefined, {
      missingChangelog: true,
      minReleasesLast30Days: 3,
    });
    expect(rows.map((r) => r.id)).toEqual(["src_5"]);
  });

  it("composes with an orgId whereClause", async () => {
    // Per-org variant of the candidate hunt: org_b sources missing a changelog
    // are src_3 and src_5 (org_b has src_3, src_4, src_5 — src_4 has a CHANGELOG).
    const rows = await getSourcesWithStats(tdb.db as never, eq(sources.orgId, "org_b"), {
      missingChangelog: true,
    });
    expect(rows.map((r) => r.id).toSorted()).toEqual(["src_3", "src_5"]);
  });
});
