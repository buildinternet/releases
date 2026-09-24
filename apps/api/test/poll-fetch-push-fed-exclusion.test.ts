/**
 * `queryDueSources` must exclude sources with `metadata.ingestMode = "push"`
 * (#2374) — push-fed sources are written directly by their publisher (e.g.
 * `actions/publish-changelog`), so the poll cron must never touch them.
 * Mirrors `poll-fetch-firecrawl-exclusion.test.ts`'s NULL-safe shape.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { queryDueSources } from "../src/cron/poll-fetch.js";

const NOW = new Date("2026-05-29T12:00:00.000Z");

function mkDb() {
  const sqlite = new Database(":memory:");
  const rawDb = drizzle(sqlite);
  applyMigrations(sqlite);
  return ensureBatchShim(rawDb);
}

describe("queryDueSources — push-fed exclusion", () => {
  it("excludes ingestMode=push source; includes non-push and non-matching values", async () => {
    const db = mkDb();
    await db
      .insert(organizations)
      .values({ id: "org_x", slug: "test-org", name: "Test Org", category: "cloud" });

    // Source with ingestMode = "push" — must be excluded.
    await db.insert(sources).values({
      id: "src_push",
      orgId: "org_x",
      slug: "push-src",
      name: "Push Source",
      type: "scrape",
      url: "https://acme.com/changelog",
      metadata: JSON.stringify({
        feedUrl: "https://acme.com/feed.xml",
        ingestMode: "push",
      }),
      fetchPriority: "normal",
      lastPolledAt: null,
      nextFetchAfter: null,
    });

    // Source with no ingestMode key at all — must be included.
    await db.insert(sources).values({
      id: "src_plain",
      orgId: "org_x",
      slug: "plain-src",
      name: "Plain Source",
      type: "feed",
      url: "https://plain.com/changelog",
      metadata: JSON.stringify({ feedUrl: "https://plain.com/feed.xml" }),
      fetchPriority: "normal",
      lastPolledAt: null,
      nextFetchAfter: null,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const due = await queryDueSources(db as any, NOW);
    const ids = due.map((s) => s.id).toSorted();

    expect(ids).not.toContain("src_push");
    expect(ids).toContain("src_plain");
    expect(ids).toHaveLength(1);
  });
});
