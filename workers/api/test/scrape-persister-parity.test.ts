/**
 * HTTP ↔ D1 scrape-persister parity (#1946 phase 4, task 7).
 *
 * Drives an identical script through both `ScrapePersister` implementations —
 * `httpPersister` (packages/adapters/src/scrape-persister.ts), wired to the
 * real route handlers in-process via `createTestApp`, and `d1ScrapePersister`
 * (workers/api/src/lib/d1-scrape-persister.ts), which calls the extracted
 * ingest helpers directly — against two identically-seeded fixture DBs, then
 * asserts the observable DB writes are identical. This is the "direct == HTTP"
 * parity gate for the #1946 deterministic-update-workflow migration: the
 * workflow adopts the D1 persister only because it is a faithful drop-in for
 * the HTTP path the discovery worker still uses.
 */
import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, sources, releases, fetchLog } from "@buildinternet/releases-core/schema";
import { releaseCoverage } from "@releases/db/schema-coverage.js";
import type { MappedEntry } from "@releases/adapters/extract";
import { httpPersister } from "@releases/adapters/scrape-persister";
import { sourceRoutes } from "../src/routes/sources.js";
import { fetchLogRoutes } from "../src/routes/fetch-log.js";
import { d1ScrapePersister, type D1PersisterEnv } from "../src/lib/d1-scrape-persister.js";
import type { D1Db } from "../src/db.js";
import { createTestApp, createTestDb, type TestDb } from "./setup";

const PAGE = "https://example.com/changelog";
const SRC_ID = "src_t1234567890123456789";
const EXISTING_RELEASE_ID = "rel_existing00000000001";
const EXISTING_URL = `${PAGE}#existing`;

/** Seed one org + one scrape source (with non-zero counters, changeDetectedAt
 * set) + one pre-existing release row whose URL a batch insert will collide
 * with, so both persisters exercise the dedup/upsert path identically. */
async function seed(db: TestDb) {
  await db
    .insert(organizations)
    .values([{ id: "org_t", slug: "testorg", name: "Test Org", category: "developer-tools" }]);
  await db.insert(sources).values([
    {
      id: SRC_ID,
      slug: "test-changelog",
      name: "Test Changelog",
      type: "scrape",
      url: PAGE,
      orgId: "org_t",
      consecutiveErrors: 2,
      consecutiveNoChange: 3,
      changeDetectedAt: "2026-07-01T00:00:00.000Z",
      nextFetchAfter: "2026-07-02T00:00:00.000Z",
    },
  ]);
  await db.insert(releases).values([
    {
      id: EXISTING_RELEASE_ID,
      sourceId: SRC_ID,
      title: "Existing release",
      content: "Original body.",
      url: EXISTING_URL,
      contentChars: 14,
      contentTokens: 4,
    },
  ]);
}

const entries: MappedEntry[] = [
  {
    title: "Dark mode",
    content: "# Dark mode\n\nFull body.",
    url: `${PAGE}#dark-mode`,
    version: "2.0.0",
    publishedAt: new Date("2026-07-05T00:00:00.000Z"),
  },
  // Same URL as the seeded row — exercises the UNIQUE(source_id, url) upsert
  // dedup path identically on both sides.
  {
    title: "Existing release (re-fetched)",
    content: "Re-fetched body.",
    url: EXISTING_URL,
  },
];

/** Row-level snapshot of everything the parity assertions compare. */
async function snapshot(db: TestDb) {
  const releaseRows = await db
    .select()
    .from(releases)
    .where(eq(releases.sourceId, SRC_ID))
    .orderBy(releases.url);
  const coverageRows = await db.select().from(releaseCoverage);
  const [source] = await db.select().from(sources).where(eq(sources.id, SRC_ID));
  const logRows = await db
    .select()
    .from(fetchLog)
    .where(eq(fetchLog.sourceId, SRC_ID))
    .orderBy(fetchLog.id);
  return { releaseRows, coverageRows, source: source!, logRows };
}

describe("httpPersister vs d1ScrapePersister parity", () => {
  it("produce identical DB writes for insertReleases + updateSourceAfterFetch + writeFetchLog", async () => {
    // ── DB-A driven via httpPersister → real route handlers in-process ──
    const dbA = createTestDb();
    await seed(dbA);
    const waitUntilPromises: Promise<unknown>[] = [];
    const appA = createTestApp(dbA, [sourceRoutes, fetchLogRoutes], {
      executionCtx: {
        waitUntil: (p: Promise<unknown>) => {
          waitUntilPromises.push(p);
        },
        passThroughOnException: () => {},
      } as unknown as ExecutionContext,
    });
    const persisterA = httpPersister({
      apiFetcher: {
        fetch: (input, init) => Promise.resolve(appA(new Request(input as string, init))),
      },
      apiKey: "fixture-key",
      sessionId: "sess_parity",
    });

    // ── DB-B driven directly via d1ScrapePersister ──
    const dbB = createTestDb();
    await seed(dbB);
    const bareEnv = {} as unknown as D1PersisterEnv;
    const persisterB = d1ScrapePersister({
      db: dbB as unknown as D1Db,
      env: bareEnv,
      sessionId: "sess_parity",
      captureRawSnapshots: false,
    });

    // ── Identical script through both ──
    const srcA = (await persisterA.getSource(SRC_ID))!;
    const srcB = (await persisterB.getSource(SRC_ID))!;
    expect(srcA).not.toBeNull();
    expect(srcB).not.toBeNull();

    const resultA = await persisterA.insertReleases(srcA, entries);
    await Promise.all(waitUntilPromises.splice(0));
    const resultB = await persisterB.insertReleases(srcB, entries);

    await persisterA.updateSourceAfterFetch(srcA);
    await Promise.all(waitUntilPromises.splice(0));
    await persisterB.updateSourceAfterFetch(srcB);

    for (let i = 0; i < 5; i++) {
      await persisterA.writeFetchLog(SRC_ID, {
        status: "no_change",
        wasFlagged: true,
        releasesFound: 0,
        releasesInserted: 0,
        durationMs: 5,
      });
      await Promise.all(waitUntilPromises.splice(0));
      await persisterB.writeFetchLog(SRC_ID, {
        status: "no_change",
        wasFlagged: true,
        releasesFound: 0,
        releasesInserted: 0,
        durationMs: 5,
      });
    }

    // ── insertReleases return-value parity ──
    // ids are nanoid-random and will never match across the two runs — compare
    // counts and confirm every id is `rel_`-prefixed.
    expect(resultA.inserted).toBe(resultB.inserted);
    expect(resultA.insertedIds.length).toBe(resultB.insertedIds.length);
    for (const id of [...resultA.insertedIds, ...resultB.insertedIds]) {
      expect(id.startsWith("rel_")).toBe(true);
    }

    // ── row-level DB parity ──
    const snapA = await snapshot(dbA);
    const snapB = await snapshot(dbB);

    // releases: count, urls, titles (ids differ by nanoid, so excluded)
    expect(snapA.releaseRows.length).toBe(snapB.releaseRows.length);
    expect(snapA.releaseRows.map((r) => r.url)).toEqual(snapB.releaseRows.map((r) => r.url));
    expect(snapA.releaseRows.map((r) => r.title)).toEqual(snapB.releaseRows.map((r) => r.title));
    // Dedup: the seeded URL must still resolve to exactly one row on both sides.
    expect(snapA.releaseRows.filter((r) => r.url === EXISTING_URL).length).toBe(1);
    expect(snapB.releaseRows.filter((r) => r.url === EXISTING_URL).length).toBe(1);

    // release_coverage: neither path runs AI grouping, so both stay empty —
    // asserting equality (not just emptiness) still pins the parity contract.
    expect(snapA.coverageRows.length).toBe(snapB.coverageRows.length);

    // sources counters
    expect(snapA.source.changeDetectedAt).toBeNull();
    expect(snapB.source.changeDetectedAt).toBeNull();
    expect(snapA.source.consecutiveErrors).toBe(0);
    expect(snapB.source.consecutiveErrors).toBe(0);
    expect(snapA.source.consecutiveNoChange).toBe(0);
    expect(snapB.source.consecutiveNoChange).toBe(0);
    expect(snapA.source.nextFetchAfter).toBeNull();
    expect(snapB.source.nextFetchAfter).toBeNull();
    expect(snapA.source.unproductiveDrains).toBe(snapB.source.unproductiveDrains);
    // 5 flagged-but-empty drains hit UNPRODUCTIVE_DRAIN_PAUSE_AFTER — both sides
    // must auto-pause identically.
    expect(snapA.source.fetchPriority).toBe("paused");
    expect(snapB.source.fetchPriority).toBe("paused");
    // last_fetched_at: nullness/shape only — the two paths run at slightly
    // different wall-clock instants.
    expect(snapA.source.lastFetchedAt).not.toBeNull();
    expect(snapB.source.lastFetchedAt).not.toBeNull();
    expect(typeof snapA.source.lastFetchedAt).toBe(typeof snapB.source.lastFetchedAt);

    // fetch_log: count + status. `wasFlagged` is a transport-only signal, never
    // a column — confirm it is absent from the row shape on both sides.
    expect(snapA.logRows.length).toBe(5);
    expect(snapB.logRows.length).toBe(5);
    expect(snapA.logRows.map((r) => r.status)).toEqual(snapB.logRows.map((r) => r.status));
    expect(snapA.logRows.every((r) => r.status === "no_change")).toBe(true);
    expect(snapB.logRows.every((r) => r.status === "no_change")).toBe(true);
    for (const row of [...snapA.logRows, ...snapB.logRows]) {
      expect(Object.hasOwn(row, "wasFlagged")).toBe(false);
    }
  });
});
