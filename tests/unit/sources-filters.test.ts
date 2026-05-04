/**
 * Unit tests for the new server-side `?type=` and `?stale=` filters wired
 * through `getSourcesWithStats` / `countSourcesForList`. Status dashboard
 * paging (#735) depends on these filters being applied at the DB layer.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
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
