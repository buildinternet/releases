import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources, fetchLog } from "@buildinternet/releases-core/schema";
import type { D1Db } from "../src/db.js";
import { ingestFetchLog } from "../src/lib/fetch-log-ingest.js";

// Direct (non-HTTP) coverage of the extracted ingest core (#1946 phase 4, task
// 4) — the route-level backoff/convergence behavior is already covered by
// fetch-log-backoff.test.ts and fetch-log-convergence.test.ts via HTTP; these
// exercise `ingestFetchLog` in-process, as a future D1 persister would.

function mkDb(): D1Db {
  const sqlite = new Database(":memory:");
  const rawDb = drizzle(sqlite);
  applyMigrations(sqlite);
  return ensureBatchShim(rawDb) as unknown as D1Db;
}

async function seedSource(db: D1Db, overrides: Record<string, unknown> = {}) {
  await db
    .insert(organizations)
    .values({ id: "org_a", slug: "acme", name: "Acme", category: "cloud" });
  await db.insert(sources).values({
    id: "src_a1",
    orgId: "org_a",
    slug: "acme-one",
    name: "Acme One",
    url: "https://a.test/changelog",
    type: "scrape",
    ...overrides,
  });
}

async function readSource(db: D1Db) {
  const [row] = await db
    .select({
      consecutiveErrors: sources.consecutiveErrors,
      nextFetchAfter: sources.nextFetchAfter,
      fetchPriority: sources.fetchPriority,
      unproductiveDrains: sources.unproductiveDrains,
    })
    .from(sources)
    .where(eq(sources.id, "src_a1"));
  return row;
}

const baseInput = {
  sourceId: "src_a1",
  sessionId: null,
  releasesFound: 0,
  releasesInserted: 0,
  durationMs: 100,
  status: "no_change",
  error: null,
  errorCategory: null,
};

describe("ingestFetchLog", () => {
  it("bumps consecutive_errors and sets next_fetch_after on a bot_challenge failure", async () => {
    const db = mkDb();
    await seedSource(db);

    await ingestFetchLog(
      db,
      {},
      {
        ...baseInput,
        status: "blocked",
        error: "interstitial",
        errorCategory: "bot_challenge",
      },
    );

    const row = await readSource(db);
    expect(row.consecutiveErrors).toBe(1);
    expect(row.nextFetchAfter).not.toBeNull();
  });

  it("increments unproductive_drains on wasFlagged + 0 inserted, and pauses on the 5th consecutive call", async () => {
    const db = mkDb();
    await seedSource(db);

    for (let i = 0; i < 4; i++) {
      await ingestFetchLog(db, {}, { ...baseInput, wasFlagged: true });
      const row = await readSource(db);
      expect(row.unproductiveDrains).toBe(i + 1);
      expect(row.fetchPriority).not.toBe("paused");
    }

    await ingestFetchLog(db, {}, { ...baseInput, wasFlagged: true });
    const row = await readSource(db);
    expect(row.unproductiveDrains).toBe(5);
    expect(row.fetchPriority).toBe("paused");
  });

  it("resets unproductive_drains on wasFlagged + releasesInserted > 0", async () => {
    const db = mkDb();
    await seedSource(db);

    await ingestFetchLog(db, {}, { ...baseInput, wasFlagged: true });
    await ingestFetchLog(db, {}, { ...baseInput, wasFlagged: true });
    expect((await readSource(db)).unproductiveDrains).toBe(2);

    await ingestFetchLog(
      db,
      {},
      {
        ...baseInput,
        wasFlagged: true,
        releasesInserted: 3,
        status: "success",
      },
    );
    expect((await readSource(db)).unproductiveDrains).toBe(0);
  });

  it("never lands wasFlagged as a fetch_log column", async () => {
    const db = mkDb();
    await seedSource(db);

    const row = await ingestFetchLog(db, {}, { ...baseInput, wasFlagged: true });
    expect(row).not.toHaveProperty("wasFlagged");

    const [persisted] = await db.select().from(fetchLog).where(eq(fetchLog.id, row.id));
    expect(persisted).not.toHaveProperty("wasFlagged");
  });
});
