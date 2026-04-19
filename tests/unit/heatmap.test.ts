import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { organizations, sources, releases } from "@releases/core-internal/schema";

let testDatabase: TestDatabase;
testDatabase = createTestDb();

afterAll(() => {
  testDatabase.cleanup();
});

function getDb() {
  return testDatabase.db;
}

describe("Heatmap daily bucketing", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(releases).run();
    db.delete(sources).run();
    db.delete(organizations).run();
  });

  function seedOrg() {
    const db = getDb();
    db.insert(organizations).values({ id: "org_1", name: "Acme", slug: "acme" }).run();
    db.insert(sources)
      .values({
        id: "src_1",
        name: "Blog",
        slug: "acme-blog",
        type: "feed",
        url: "https://acme.com/blog",
        orgId: "org_1",
      })
      .run();
  }

  function insertRelease(id: string, publishedAt: string) {
    const db = getDb();
    db.insert(releases)
      .values({
        id,
        sourceId: "src_1",
        title: `Release ${id}`,
        content: "",
        url: `https://acme.com/${id}`,
        contentHash: id,
        publishedAt,
        fetchedAt: new Date().toISOString(),
      })
      .run();
  }

  it("groups releases by date", () => {
    seedOrg();
    insertRelease("r1", "2026-03-10T10:00:00Z");
    insertRelease("r2", "2026-03-10T15:00:00Z");
    insertRelease("r3", "2026-03-11T08:00:00Z");

    const db = getDb();
    const rows = db.all<{ date: string; cnt: number }>(sql`
      SELECT
        DATE(r.published_at) AS date,
        COUNT(*) AS cnt
      FROM releases r
      INNER JOIN sources s ON s.id = r.source_id
      WHERE
        s.org_id = 'org_1'
        AND r.published_at IS NOT NULL
        AND (r.suppressed IS NULL OR r.suppressed = 0)
        AND r.published_at >= '2026-03-01'
        AND r.published_at < '2026-04-01'
      GROUP BY DATE(r.published_at)
      ORDER BY date
    `);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ date: "2026-03-10", cnt: 2 });
    expect(rows[1]).toEqual({ date: "2026-03-11", cnt: 1 });
  });

  it("excludes suppressed releases", () => {
    seedOrg();
    insertRelease("r1", "2026-03-10T10:00:00Z");

    const db = getDb();
    // Suppress the release
    db.run(sql`UPDATE releases SET suppressed = 1 WHERE id = 'r1'`);

    const rows = db.all<{ date: string; cnt: number }>(sql`
      SELECT
        DATE(r.published_at) AS date,
        COUNT(*) AS cnt
      FROM releases r
      INNER JOIN sources s ON s.id = r.source_id
      WHERE
        s.org_id = 'org_1'
        AND r.published_at IS NOT NULL
        AND (r.suppressed IS NULL OR r.suppressed = 0)
        AND r.published_at >= '2026-03-01'
        AND r.published_at < '2026-04-01'
      GROUP BY DATE(r.published_at)
      ORDER BY date
    `);

    expect(rows).toHaveLength(0);
  });

  it("respects date range boundaries", () => {
    seedOrg();
    insertRelease("r1", "2026-02-28T23:59:00Z"); // outside range
    insertRelease("r2", "2026-03-01T00:00:00Z"); // inside range
    insertRelease("r3", "2026-03-31T23:59:00Z"); // inside range
    insertRelease("r4", "2026-04-01T00:00:00Z"); // outside range (exclusive upper)

    const db = getDb();
    const rows = db.all<{ date: string; cnt: number }>(sql`
      SELECT
        DATE(r.published_at) AS date,
        COUNT(*) AS cnt
      FROM releases r
      INNER JOIN sources s ON s.id = r.source_id
      WHERE
        s.org_id = 'org_1'
        AND r.published_at IS NOT NULL
        AND (r.suppressed IS NULL OR r.suppressed = 0)
        AND r.published_at >= '2026-03-01'
        AND r.published_at < '2026-04-01'
      GROUP BY DATE(r.published_at)
      ORDER BY date
    `);

    expect(rows).toHaveLength(2);
    expect(rows[0].date).toBe("2026-03-01");
    expect(rows[1].date).toBe("2026-03-31");
  });

  it("only includes releases from the target org", () => {
    const db = getDb();
    seedOrg();
    // Another org's source
    db.insert(organizations).values({ id: "org_2", name: "Other", slug: "other" }).run();
    db.insert(sources)
      .values({
        id: "src_2",
        name: "Other Blog",
        slug: "other-blog",
        type: "feed",
        url: "https://other.com/blog",
        orgId: "org_2",
      })
      .run();

    insertRelease("r1", "2026-03-10T10:00:00Z");
    db.insert(releases)
      .values({
        id: "r2",
        sourceId: "src_2",
        title: "Other Release",
        content: "",
        url: "https://other.com/r2",
        contentHash: "r2",
        publishedAt: "2026-03-10T10:00:00Z",
        fetchedAt: new Date().toISOString(),
      })
      .run();

    const rows = db.all<{ date: string; cnt: number }>(sql`
      SELECT
        DATE(r.published_at) AS date,
        COUNT(*) AS cnt
      FROM releases r
      INNER JOIN sources s ON s.id = r.source_id
      WHERE
        s.org_id = 'org_1'
        AND r.published_at IS NOT NULL
        AND (r.suppressed IS NULL OR r.suppressed = 0)
        AND r.published_at >= '2026-03-01'
        AND r.published_at < '2026-04-01'
      GROUP BY DATE(r.published_at)
      ORDER BY date
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ date: "2026-03-10", cnt: 1 });
  });
});
