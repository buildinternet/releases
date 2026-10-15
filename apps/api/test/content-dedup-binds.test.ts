/**
 * Same-day content-identity lookups OR one published_at range per day.
 * An unchunked list from a busy source binds well past D1's cap of 100
 * (`SQLITE_ERROR: too many SQL variables` on PollAndFetchWorkflow). These
 * tests compile the real statement and run the chunked reader.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { organizations, releases, sources } from "@buildinternet/releases-core/schema";
import { D1_MAX_BINDINGS } from "@buildinternet/releases-core/d1-limits";
import { applyMigrations } from "../../../tests/db-helper";
import {
  CONTENT_IDENTITY_DAY_CHUNK_SIZE,
  contentIdentityDayQuery,
  selectExistingContentIdentities,
} from "../src/lib/ingest/content-dedup.js";

function isoDays(count: number, start = "2020-01-01"): string[] {
  const out: string[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  for (let i = 0; i < count; i++) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

describe("content-identity day lookup bind budget", () => {
  const db = drizzle(new Database(":memory:"));

  it("a full day chunk stays within the cap and matches the 1 + 2-per-day estimate", () => {
    const days = isoDays(CONTENT_IDENTITY_DAY_CHUNK_SIZE);
    const q = contentIdentityDayQuery(db, "src_x", days).toSQL();
    expect(q.params.length).toBe(1 + CONTENT_IDENTITY_DAY_CHUNK_SIZE * 2);
    expect(q.params.length).toBeLessThanOrEqual(D1_MAX_BINDINGS);
  });

  it("one day past the chunk throws before a statement is built", () => {
    const days = isoDays(CONTENT_IDENTITY_DAY_CHUNK_SIZE + 1);
    expect(1 + days.length * 2).toBeGreaterThan(D1_MAX_BINDINGS);
    expect(() => contentIdentityDayQuery(db, "src_x", days)).toThrow(/content-identity day lookup/);
  });

  it("an empty day list throws instead of building an empty OR", () => {
    expect(() => contentIdentityDayQuery(db, "src_x", [])).toThrow(/at least one day/);
  });

  it("a single day is a range predicate, not an empty OR", () => {
    const q = contentIdentityDayQuery(db, "src_x", ["2026-10-09"]).toSQL();
    expect(q.params).toEqual(["src_x", "2026-10-09", "2026-10-10"]);
  });
});

describe("selectExistingContentIdentities chunking", () => {
  it("returns rows from every day chunk and keeps each statement under the cap", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const sqlite = new Database(":memory:");
    sqlite.run("PRAGMA foreign_keys=ON");
    applyMigrations(sqlite);
    const db = drizzle(sqlite, {
      logger: {
        logQuery(sql, params) {
          queries.push({ sql, params });
        },
      },
    });

    await db.insert(organizations).values({ id: "org_a", slug: "acme", name: "Acme" });
    await db.insert(sources).values({
      id: "src_a",
      slug: "changelog",
      name: "Changelog",
      type: "github",
      url: "https://example.invalid/changelog",
      orgId: "org_a",
    });

    const days = isoDays(CONTENT_IDENTITY_DAY_CHUNK_SIZE + 5);
    const early = days[0]!;
    const late = days[CONTENT_IDENTITY_DAY_CHUNK_SIZE]!;
    await db.insert(releases).values([
      {
        id: "rel_early",
        sourceId: "src_a",
        title: "Early",
        content: "early body",
        url: "https://example.invalid/early",
        publishedAt: early,
        bodyHash: "hash-early",
      },
      {
        id: "rel_late",
        sourceId: "src_a",
        title: "Late",
        content: "late body",
        url: "https://example.invalid/late",
        publishedAt: `${late}T12:00:00.000Z`,
        bodyHash: "hash-late",
      },
      {
        id: "rel_other",
        sourceId: "src_a",
        title: "Outside",
        content: "outside",
        url: "https://example.invalid/outside",
        publishedAt: "2019-01-01",
        bodyHash: "hash-outside",
      },
    ]);

    queries.length = 0;
    const found = await selectExistingContentIdentities(db, "src_a", [...days, early]);
    const urls = found.map((row) => row.url).toSorted();
    expect(urls).toEqual(["https://example.invalid/early", "https://example.invalid/late"]);

    const lookups = queries.filter((q) => q.sql.includes("body_hash"));
    expect(lookups.length).toBeGreaterThan(1);
    for (const query of lookups) {
      expect(query.params.length).toBeLessThanOrEqual(D1_MAX_BINDINGS);
    }

    sqlite.close();
  });

  it("returns nothing for an empty day list without querying", async () => {
    const queries: string[] = [];
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite, {
      logger: {
        logQuery(sql) {
          queries.push(sql);
        },
      },
    });
    const found = await selectExistingContentIdentities(db, "src_a", []);
    expect(found).toEqual([]);
    expect(queries).toEqual([]);
    sqlite.close();
  });
});
