/**
 * HTTP ↔ D1 scrape-persister parity (#1946 phase 4, task 7).
 *
 * The deterministic update workflow swaps `httpPersister` (adapter → API
 * worker over HTTP) for `d1ScrapePersister` (same writes, in-process). This
 * suite is the "direct == HTTP" gate: it drives an IDENTICAL script through
 * both persisters against two identically-seeded fixture DBs — persister A is
 * the real `httpPersister` whose `apiFetcher` invokes the real Hono route
 * handlers in-process against DB-A; persister B is `d1ScrapePersister` on
 * DB-B — then asserts row-level equality of every observable write:
 * releases (dedup included), release_coverage, sources counters (including
 * the #1862 unproductive-drain auto-pause), and fetch_log.
 *
 * Timestamps are compared by nullness/shape, not instant — the two sides run
 * at different wall-clock moments. IDs are nanoid-random, so ID parity is
 * count + `rel_` prefix, not equality.
 */
import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, sources, releases, fetchLog } from "@buildinternet/releases-core/schema";
import { releaseCoverage } from "@releases/core-internal/schema-coverage.js";
import type { MappedEntry } from "@releases/adapters/extract";
import { httpPersister, type ScrapePersister } from "@releases/adapters/scrape-persister";
import { d1ScrapePersister, type D1PersisterEnv } from "../src/lib/d1-scrape-persister.js";
import type { D1Db } from "../src/db.js";
import { sourceRoutes } from "../src/routes/sources.js";
import { fetchLogRoutes } from "../src/routes/fetch-log.js";
import { createTestDb, createTestApp, type TestDb } from "./setup";

const PAGE = "https://example.com/changelog";
const SRC_ID = "src_parity890123456789";
const SEEDED_URL = `${PAGE}#already-known`;
const SESSION_ID = "sess_parity";

/** Identical seed for both DBs: one org, one scrape source with non-zero
 * counters + changeDetectedAt set, and one existing release the batch will
 * collide with on URL. */
async function seed(db: TestDb) {
  await db
    .insert(organizations)
    .values([{ id: "org_p", slug: "parityorg", name: "Parity Org", category: "developer-tools" }]);
  await db.insert(sources).values([
    {
      id: SRC_ID,
      slug: "parity-changelog",
      name: "Parity Changelog",
      type: "scrape",
      url: PAGE,
      orgId: "org_p",
      changeDetectedAt: "2026-07-01T00:00:00.000Z",
      consecutiveErrors: 3,
      consecutiveNoChange: 2,
      nextFetchAfter: "2026-07-09T00:00:00.000Z",
      unproductiveDrains: 0,
    },
  ]);
  await db.insert(releases).values([
    {
      id: "rel_seeded000000000000000",
      sourceId: SRC_ID,
      title: "Already known",
      content: "Existing full body — fill-only upsert must not clobber this.",
      url: SEEDED_URL,
      publishedAt: "2026-06-20T00:00:00.000Z",
    },
  ]);
}

const ENTRIES: MappedEntry[] = [
  {
    title: "Dark mode",
    content: "# Dark mode\n\nFull body.",
    url: `${PAGE}#dark-mode`,
    version: "2.0.0",
    publishedAt: new Date("2026-07-01T00:00:00.000Z"),
  },
  {
    // Same URL as the seeded row → the UNIQUE(source_id, url) upsert dedups.
    title: "Already known",
    content: "Re-extracted duplicate of the seeded release.",
    url: SEEDED_URL,
  },
];

const FETCH_LOG_INPUT = {
  status: "no_change",
  wasFlagged: true,
  releasesFound: 0,
  releasesInserted: 0,
  durationMs: 5,
} as const;

// Minimal env, identical on both sides: no MEDIA / Vectorize / hub / actor
// bindings, so every post-insert effect degrades to a no-op on the HTTP side
// exactly as `skipEmbed`/`skipInvalidate` do on the D1 side.
const bareEnv = {} as unknown as D1PersisterEnv;

function mkHttpSide(db: TestDb) {
  // Collect the route handlers' waitUntil promises (playbook regen, batch
  // ingest effects) so the test can await them before asserting DB state —
  // the D1 persister awaits its effects inline, so the HTTP side must be
  // settled too for a fair comparison.
  const pending: Promise<unknown>[] = [];
  const handler = createTestApp(db, [sourceRoutes, fetchLogRoutes], {
    env: { ...bareEnv },
    executionCtx: {
      waitUntil: (p: Promise<unknown>) => {
        pending.push(p.catch(() => {}));
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
  });
  const persister = httpPersister({
    apiFetcher: {
      fetch: async (input, init) => handler(new Request(input, init)),
    },
    apiKey: "test-parity-key",
    sessionId: SESSION_ID,
    captureRawSnapshots: false,
  });
  return { persister, settle: () => Promise.allSettled(pending) };
}

function mkD1Side(db: TestDb): ScrapePersister {
  return d1ScrapePersister({
    db: db as unknown as D1Db,
    env: bareEnv,
    sessionId: SESSION_ID,
    captureRawSnapshots: false,
  });
}

/** The identical script both persisters run. Returns the insertReleases result. */
async function runScript(p: ScrapePersister) {
  const src = await p.getSource(SRC_ID);
  expect(src).not.toBeNull();
  const insertResult = await p.insertReleases(src!, ENTRIES);
  await p.updateSourceAfterFetch(src!);
  for (let i = 0; i < 5; i++) {
    // oxlint-disable-next-line no-await-in-loop -- sequential drains, order matters for the pause counter
    await p.writeFetchLog(SRC_ID, { ...FETCH_LOG_INPUT });
  }
  return insertResult;
}

describe("scrape-persister parity: httpPersister (in-process routes) vs d1ScrapePersister", () => {
  it("produces identical observable DB writes and return values", async () => {
    const dbA = createTestDb(); // HTTP side
    const dbB = createTestDb(); // D1 side
    await seed(dbA);
    await seed(dbB);

    const { persister: httpSide, settle } = mkHttpSide(dbA);
    const d1Side = mkD1Side(dbB);

    const resultA = await runScript(httpSide);
    await settle();
    const resultB = await runScript(d1Side);

    // ── insertReleases return-value parity ──────────────────────────────
    // One of the two entries collides with the seeded URL (stored content
    // non-empty → fill-only upsert is a true no-op), so both report 1.
    expect(resultA.inserted).toBe(resultB.inserted);
    expect(resultA.insertedIds.length).toBe(resultB.insertedIds.length);
    for (const id of [...resultA.insertedIds, ...resultB.insertedIds]) {
      expect(id).toMatch(/^rel_/);
    }
    expect(resultA.inserted).toBe(1);

    // ── releases rows ────────────────────────────────────────────────────
    const relsA = await dbA.select().from(releases).where(eq(releases.sourceId, SRC_ID));
    const relsB = await dbB.select().from(releases).where(eq(releases.sourceId, SRC_ID));
    expect(relsA.length).toBe(relsB.length);
    expect(relsA.length).toBe(2); // seeded + 1 new; the duplicate URL deduped
    const key = (r: { url: string | null; title: string; content: string }) =>
      `${r.url} | ${r.title} | ${r.content}`;
    expect(relsA.map(key).sort()).toEqual(relsB.map(key).sort());
    // The seeded row's content was NOT clobbered by the same-URL re-POST.
    const seededA = relsA.find((r) => r.url === SEEDED_URL)!;
    const seededB = relsB.find((r) => r.url === SEEDED_URL)!;
    expect(seededA.content).toBe(seededB.content);
    expect(seededA.content).toContain("Existing full body");
    // Neither side embeds inline (HTTP: no embed bindings; D1: skipEmbed).
    for (const r of [...relsA, ...relsB]) expect(r.embeddedAt).toBeNull();

    // ── release_coverage rows ────────────────────────────────────────────
    const covA = await dbA.select().from(releaseCoverage);
    const covB = await dbB.select().from(releaseCoverage);
    expect(covA.length).toBe(covB.length);

    // ── sources counters ─────────────────────────────────────────────────
    const [srcA] = await dbA.select().from(sources).where(eq(sources.id, SRC_ID));
    const [srcB] = await dbB.select().from(sources).where(eq(sources.id, SRC_ID));
    // updateSourceAfterFetch reset everything on both sides…
    expect(srcA!.lastFetchedAt).not.toBeNull();
    expect(srcB!.lastFetchedAt).not.toBeNull();
    expect(srcA!.changeDetectedAt).toBeNull();
    expect(srcB!.changeDetectedAt).toBeNull();
    expect(srcA!.consecutiveErrors).toBe(0);
    expect(srcB!.consecutiveErrors).toBe(0);
    expect(srcA!.consecutiveNoChange).toBe(0);
    expect(srcB!.consecutiveNoChange).toBe(0);
    expect(srcA!.nextFetchAfter).toBeNull();
    expect(srcB!.nextFetchAfter).toBeNull();
    // …then five flagged-but-empty drains accumulated and auto-paused (#1862).
    expect(srcA!.unproductiveDrains).toBe(5);
    expect(srcB!.unproductiveDrains).toBe(5);
    expect(srcA!.fetchPriority).toBe("paused");
    expect(srcB!.fetchPriority).toBe("paused");

    // ── fetch_log rows ───────────────────────────────────────────────────
    const logsA = await dbA.select().from(fetchLog);
    const logsB = await dbB.select().from(fetchLog);
    expect(logsA.length).toBe(5);
    expect(logsB.length).toBe(5);
    for (const row of [...logsA, ...logsB]) {
      expect(row.sourceId).toBe(SRC_ID);
      expect(row.sessionId).toBe(SESSION_ID);
      expect(row.status).toBe("no_change");
      expect(row.releasesFound).toBe(0);
      expect(row.releasesInserted).toBe(0);
      expect(row.durationMs).toBe(5);
      // wasFlagged is transport-only (#1862) — never a fetch_log column.
      expect("wasFlagged" in row).toBe(false);
      expect(row.createdAt).not.toBeNull();
    }
  });
});
