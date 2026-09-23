/**
 * `queryDueSources` must exclude sources with `metadata.firecrawl.enabled = true`.
 * Firecrawl-owned sources are ingested via the inbound webhook + workflow; the
 * poll-fetch cron must never touch them (double-ingest risk). Sources where the
 * firecrawl key is absent (NULL) or explicitly false must stay in the due set.
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

describe("queryDueSources — firecrawl-owned exclusion", () => {
  it("excludes firecrawl-enabled source; includes non-firecrawl and firecrawl=false", async () => {
    const db = mkDb();
    await db
      .insert(organizations)
      .values({ id: "org_x", slug: "test-org", name: "Test Org", category: "cloud" });

    // Source with firecrawl.enabled = true — must be excluded.
    await db.insert(sources).values({
      id: "src_firecrawl",
      orgId: "org_x",
      slug: "firecrawl-src",
      name: "Firecrawl Source",
      type: "scrape",
      url: "https://acme.com/changelog",
      metadata: JSON.stringify({
        feedUrl: "https://acme.com/feed.xml",
        firecrawl: { enabled: true },
      }),
      fetchPriority: "normal",
      lastPolledAt: null,
      nextFetchAfter: null,
    });

    // Source with no firecrawl key at all — must be included.
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

    // Source with firecrawl.enabled = false — must be included (opt-out is explicit).
    await db.insert(sources).values({
      id: "src_firecrawl_off",
      orgId: "org_x",
      slug: "firecrawl-off-src",
      name: "Firecrawl Off Source",
      type: "scrape",
      url: "https://other.com/changelog",
      metadata: JSON.stringify({
        feedUrl: "https://other.com/feed.xml",
        firecrawl: { enabled: false },
      }),
      fetchPriority: "normal",
      lastPolledAt: null,
      nextFetchAfter: null,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const due = await queryDueSources(db as any, NOW);
    const ids = due.map((s) => s.id).toSorted();

    expect(ids).not.toContain("src_firecrawl");
    expect(ids).toContain("src_plain");
    expect(ids).toContain("src_firecrawl_off");
    expect(ids).toHaveLength(2);
  });
});
