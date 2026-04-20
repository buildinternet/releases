import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../db-helper";
import { sources, organizations } from "@buildinternet/releases-core/schema";
import { queryCandidates } from "../../workers/api/src/cron/scrape-agent-sweep";

function seed() {
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
      // Eligible: scrape, flagged, no feedUrl, not paused, not hidden
      {
        id: "src_1",
        name: "S1",
        slug: "s-1",
        type: "scrape",
        url: "https://a.com/changelog",
        orgId: "org_a",
        changeDetectedAt: "2026-04-18T00:00:00Z",
        metadata: JSON.stringify({ noFeedFound: true }),
      },
      {
        id: "src_2",
        name: "S2",
        slug: "s-2",
        type: "scrape",
        url: "https://b.com/changelog",
        orgId: "org_b",
        changeDetectedAt: "2026-04-17T00:00:00Z",
        metadata: "{}",
      },
      // Ineligible: has feedUrl
      {
        id: "src_3",
        name: "S3",
        slug: "s-3",
        type: "scrape",
        url: "https://a.com/releases",
        orgId: "org_a",
        changeDetectedAt: "2026-04-18T00:00:00Z",
        metadata: JSON.stringify({ feedUrl: "https://a.com/rss.xml", feedType: "rss" }),
      },
      // Ineligible: paused
      {
        id: "src_4",
        name: "S4",
        slug: "s-4",
        type: "scrape",
        url: "https://a.com/notes",
        orgId: "org_a",
        changeDetectedAt: "2026-04-18T00:00:00Z",
        fetchPriority: "paused",
        metadata: "{}",
      },
      // Ineligible: not flagged
      {
        id: "src_5",
        name: "S5",
        slug: "s-5",
        type: "scrape",
        url: "https://a.com/news",
        orgId: "org_a",
        changeDetectedAt: null,
        metadata: "{}",
      },
      // Ineligible: github type
      {
        id: "src_6",
        name: "S6",
        slug: "s-6",
        type: "github",
        url: "https://github.com/a/b",
        orgId: "org_a",
        changeDetectedAt: "2026-04-18T00:00:00Z",
        metadata: "{}",
      },
      // Ineligible: hidden
      {
        id: "src_7",
        name: "S7",
        slug: "s-7",
        type: "scrape",
        url: "https://a.com/hidden",
        orgId: "org_a",
        changeDetectedAt: "2026-04-18T00:00:00Z",
        isHidden: true,
        metadata: "{}",
      },
      // Ineligible: no org
      {
        id: "src_8",
        name: "S8",
        slug: "s-8",
        type: "scrape",
        url: "https://orphan.com",
        orgId: null,
        changeDetectedAt: "2026-04-18T00:00:00Z",
        metadata: "{}",
      },
    ])
    .run();

  return db;
}

describe("queryCandidates", () => {
  it("returns only eligible rows, ordered by changeDetectedAt ASC, under the cap", async () => {
    const db = seed();
    const result = await queryCandidates(db, { cap: 10 });
    // src_2 has changeDetectedAt 2026-04-17 (older) → comes first under ASC
    expect(result.rows.map((r) => r.id)).toEqual(["src_2", "src_1"]);
    expect(result.skippedOverCap).toBe(0);
  });

  it("slices to cap and sets skippedOverCap when more than cap matched", async () => {
    const db = seed();
    const result = await queryCandidates(db, { cap: 1 });
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].id).toBe("src_2"); // oldest flagged first under ASC
    expect(result.skippedOverCap).toBe(1);
  });

  it("returns empty when nothing is flagged", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    applyMigrations(sqlite);
    const result = await queryCandidates(db, { cap: 10 });
    expect(result.rows).toEqual([]);
    expect(result.skippedOverCap).toBe(0);
  });
});
