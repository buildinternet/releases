import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../db-helper";
import { fetchLog, organizations, sources } from "@buildinternet/releases-core/schema";
import { aggregateSweepResults } from "../../workers/api/src/lib/sweep-results";

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  db.insert(organizations)
    .values([
      { id: "org_a", name: "Org A", slug: "a", category: "developer-tools" },
      { id: "org_b", name: "Org B", slug: "b", category: "developer-tools" },
    ])
    .run();
  db.insert(sources)
    .values([
      {
        id: "src_a1",
        name: "A1",
        slug: "a-1",
        type: "scrape",
        url: "https://a.example/1",
        orgId: "org_a",
        metadata: "{}",
      },
      {
        id: "src_a2",
        name: "A2",
        slug: "a-2",
        type: "scrape",
        url: "https://a.example/2",
        orgId: "org_a",
        metadata: "{}",
      },
      {
        id: "src_b1",
        name: "B1",
        slug: "b-1",
        type: "scrape",
        url: "https://b.example/1",
        orgId: "org_b",
        metadata: "{}",
      },
    ])
    .run();
  return db;
}

describe("aggregateSweepResults", () => {
  it("returns zeros for empty session list", async () => {
    const db = mkDb();
    const result = await aggregateSweepResults(db, []);
    expect(result.perOrg).toHaveLength(0);
    expect(result.sessionsWithNoActivity).toBe(0);
  });

  it("aggregates fetch_log rows by org and reports inactive session count", async () => {
    const db = mkDb();
    db.insert(fetchLog)
      .values([
        {
          sourceId: "src_a1",
          sessionId: "ma-1",
          releasesFound: 5,
          releasesInserted: 4,
          status: "success",
        },
        {
          sourceId: "src_a2",
          sessionId: "ma-1",
          releasesFound: 3,
          releasesInserted: 2,
          status: "success",
        },
        {
          sourceId: "src_b1",
          sessionId: "ma-2",
          releasesFound: 1,
          releasesInserted: 1,
          status: "success",
        },
      ])
      .run();

    // ma-3 dispatched but produced no fetch_log rows yet (still running).
    const result = await aggregateSweepResults(db, ["ma-1", "ma-2", "ma-3"]);
    expect(result.sessionsWithNoActivity).toBe(1);

    // Sorted by inserted desc.
    expect(result.perOrg).toHaveLength(2);
    expect(result.perOrg[0]).toMatchObject({
      orgSlug: "a",
      orgName: "Org A",
      sourcesFetched: 2,
      releasesFound: 8,
      releasesInserted: 6,
      errors: 0,
    });
    expect(result.perOrg[1]).toMatchObject({
      orgSlug: "b",
      sourcesFetched: 1,
      releasesInserted: 1,
    });
  });

  it("counts error-status fetches per org", async () => {
    const db = mkDb();
    db.insert(fetchLog)
      .values([
        {
          sourceId: "src_a1",
          sessionId: "ma-1",
          releasesFound: 0,
          releasesInserted: 0,
          status: "error",
          error: "boom",
        },
        {
          sourceId: "src_a2",
          sessionId: "ma-1",
          releasesFound: 2,
          releasesInserted: 2,
          status: "success",
        },
      ])
      .run();
    const result = await aggregateSweepResults(db, ["ma-1"]);
    expect(result.perOrg[0]?.errors).toBe(1);
    expect(result.perOrg[0]?.releasesInserted).toBe(2);
  });

  it("ignores fetch_log rows for sessions outside the input list", async () => {
    const db = mkDb();
    db.insert(fetchLog)
      .values([
        {
          sourceId: "src_a1",
          sessionId: "ma-other",
          releasesFound: 99,
          releasesInserted: 99,
          status: "success",
        },
      ])
      .run();
    const result = await aggregateSweepResults(db, ["ma-1"]);
    expect(result.perOrg).toHaveLength(0);
    expect(result.sessionsWithNoActivity).toBe(1);
  });
});
