import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import type { D1Db } from "../src/db.js";
import { Hono } from "hono";
import { fetchLogRoutes } from "../src/routes/fetch-log.js";

// Non-converging no-op drain auto-pause (#1862). The fetch-log POST handler
// counts consecutive flagged-but-empty drains and pauses the source at the
// threshold, so a source that "successfully finds nothing" forever stops
// re-billing a Haiku /update every cycle (the #1851 error backoff never catches
// it because a no-op isn't an error).

const PAUSE_AFTER = 5; // mirror UNPRODUCTIVE_DRAIN_PAUSE_AFTER in fetch-log.ts

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

function mkApp(db: D1Db) {
  const fakeEnv = { DB: db };
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", fetchLogRoutes);
  app.route("/v1", v1);
  return async (req: Request) => app.fetch(req, fakeEnv as never);
}

function postLog(fetch: (req: Request) => Promise<Response>, body: Record<string, unknown>) {
  return fetch(
    new Request("https://x.test/v1/admin/logs/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceId: "src_a1",
        releasesFound: 0,
        releasesInserted: 0,
        durationMs: 100,
        status: "no_change",
        ...body,
      }),
    }),
  );
}

async function readSource(db: D1Db) {
  const [src] = await db
    .select({
      unproductiveDrains: sources.unproductiveDrains,
      fetchPriority: sources.fetchPriority,
    })
    .from(sources)
    .where(eq(sources.id, "src_a1"));
  return src;
}

describe("fetch-log unproductive-drain auto-pause (#1862)", () => {
  it("increments unproductiveDrains on a flagged empty drain", async () => {
    const db = mkDb();
    await seedSource(db);
    const fetch = mkApp(db);
    await postLog(fetch, { wasFlagged: true });
    expect((await readSource(db)).unproductiveDrains).toBe(1);
  });

  it("does NOT count an empty poll that was not flagged (healthy quiet source)", async () => {
    const db = mkDb();
    await seedSource(db);
    const fetch = mkApp(db);
    await postLog(fetch, {}); // no wasFlagged
    const src = await readSource(db);
    expect(src.unproductiveDrains ?? 0).toBe(0);
    expect(src.fetchPriority).not.toBe("paused");
  });

  it("auto-pauses after the threshold of consecutive flagged-empty drains", async () => {
    const db = mkDb();
    await seedSource(db);
    const fetch = mkApp(db);
    for (let i = 0; i < PAUSE_AFTER; i++) {
      expect((await readSource(db)).fetchPriority).not.toBe("paused");
      await postLog(fetch, { wasFlagged: true });
    }
    const src = await readSource(db);
    expect(src.unproductiveDrains).toBe(PAUSE_AFTER);
    expect(src.fetchPriority).toBe("paused");
  });

  it("resets the streak on a productive drain (>=1 inserted)", async () => {
    const db = mkDb();
    await seedSource(db);
    const fetch = mkApp(db);
    await postLog(fetch, { wasFlagged: true });
    await postLog(fetch, { wasFlagged: true });
    expect((await readSource(db)).unproductiveDrains).toBe(2);
    await postLog(fetch, { wasFlagged: true, releasesInserted: 3, status: "success" });
    expect((await readSource(db)).unproductiveDrains).toBe(0);
  });
});
