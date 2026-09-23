/**
 * `queryDueSources` must honor the smart-fetch exponential backoff stored on
 * `sources.nextFetchAfter`. Before this gate the hourly cron re-polled on the
 * tier interval alone, so a source that kept coming back `no_change` never
 * actually relaxed its cadence — the backoff only fed the `?mode=stale` agent
 * listing endpoint. A null (never backed off) or past timestamp is ready to
 * poll; a future timestamp is held back.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { queryDueSources } from "../src/cron/poll-fetch.js";

const NOW = new Date("2026-05-27T12:00:00.000Z");

function mkDb() {
  const sqlite = new Database(":memory:");
  const rawDb = drizzle(sqlite);
  applyMigrations(sqlite);
  return ensureBatchShim(rawDb);
}

async function seedSource(
  db: ReturnType<typeof mkDb>,
  id: string,
  nextFetchAfter: string | null,
): Promise<void> {
  await db.insert(sources).values({
    id,
    orgId: "org_x",
    slug: id,
    name: id,
    type: "feed",
    url: `https://example.com/${id}`,
    metadata: JSON.stringify({
      feedUrl: `https://example.com/${id}/feed.xml`,
      feedType: "rss",
    }),
    fetchPriority: "normal",
    // Never polled → due on the tier interval; nextFetchAfter is the only
    // differentiator across the three rows.
    lastPolledAt: null,
    nextFetchAfter,
  });
}

describe("queryDueSources — nextFetchAfter backoff gate", () => {
  it("excludes a source backed off into the future; includes past + null", async () => {
    const db = mkDb();
    await db
      .insert(organizations)
      .values({ id: "org_x", slug: "x", name: "X", category: "productivity" });

    await seedSource(db, "src_future", new Date(NOW.getTime() + 8 * 3600_000).toISOString());
    await seedSource(db, "src_past", new Date(NOW.getTime() - 1 * 3600_000).toISOString());
    await seedSource(db, "src_null", null);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const due = await queryDueSources(db as any, NOW);
    const ids = due.map((s) => s.id).sort();

    expect(ids).toEqual(["src_null", "src_past"]);
    expect(ids).not.toContain("src_future");
  });
});
