/**
 * `d1ScrapePersister` (#1946 phase 4, task 6) — the direct-D1 implementation
 * of the `ScrapePersister` seam, built on the extracted ingest lib
 * (`ingestReleaseBatch`/`runBatchIngestEffects`, `ingestFetchLog`,
 * `completeSourceFetch`, `saveRawSnapshot`). These tests pin:
 *
 * - `getSource` resolves the same three identifier shapes the HTTP persister
 *   handles (`src_…` ID, `org/slug` coordinate, bare slug) and returns the
 *   full `Source` row shape adapter code reads fields off.
 * - `insertReleases` writes rows, returns `insertedIds`, and does NOT mark
 *   `embeddedAt` — embed is deliberately skipped (the workflow runs it as a
 *   durable step later).
 * - `writeFetchLog` is best-effort: a forced insert failure never throws.
 * - `captureRawSnapshot` is gated: no-op when `captureRawSnapshots` is off,
 *   stores via the content-addressed raw-snapshot path when on.
 */
import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import {
  organizations,
  sources,
  releases,
  fetchLog,
  sourceRawSnapshots,
} from "@buildinternet/releases-core/schema";
import type { MappedEntry } from "@releases/adapters/extract";
import { d1ScrapePersister, type D1PersisterEnv } from "../src/lib/d1-scrape-persister.js";
import type { D1Db } from "../src/db.js";
import { createTestDb, type TestDb } from "./setup";

const PAGE = "https://example.com/changelog";
const SRC_ID = "src_t1234567890123456789";

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
    },
  ]);
}

// Minimal env: no MEDIA / Vectorize / hub / R2 bindings — every effect
// degrades gracefully, matching the wrangler-dev-without-bindings posture.
const bareEnv = { RELEASES_INDEX: undefined } as unknown as D1PersisterEnv;

function mkPersister(db: TestDb, opts?: { env?: D1PersisterEnv; captureRawSnapshots?: boolean }) {
  return d1ScrapePersister({
    db: db as unknown as D1Db,
    env: opts?.env ?? bareEnv,
    sessionId: "sess_test",
    captureRawSnapshots: opts?.captureRawSnapshots ?? false,
  });
}

describe("d1ScrapePersister.getSource", () => {
  it("resolves a typed src_ ID", async () => {
    const db = createTestDb();
    await seed(db);
    const src = await mkPersister(db).getSource(SRC_ID);
    expect(src).not.toBeNull();
    expect(src!.id).toBe(SRC_ID);
    expect(src!.orgId).toBe("org_t");
    expect(src!.slug).toBe("test-changelog");
    expect(src!.type).toBe("scrape");
  });

  it("resolves an org/slug coordinate", async () => {
    const db = createTestDb();
    await seed(db);
    const src = await mkPersister(db).getSource("testorg/test-changelog");
    expect(src).not.toBeNull();
    expect(src!.id).toBe(SRC_ID);
    expect(src!.orgId).toBe("org_t");
  });

  it("resolves a bare slug", async () => {
    const db = createTestDb();
    await seed(db);
    const src = await mkPersister(db).getSource("test-changelog");
    expect(src).not.toBeNull();
    expect(src!.id).toBe(SRC_ID);
    expect(src!.type).toBe("scrape");
  });

  it("returns null for an unknown identifier", async () => {
    const db = createTestDb();
    await seed(db);
    expect(await mkPersister(db).getSource("src_doesnotexist000000")).toBeNull();
    expect(await mkPersister(db).getSource("no-such-slug")).toBeNull();
    expect(await mkPersister(db).getSource("testorg/no-such-slug")).toBeNull();
  });
});

describe("d1ScrapePersister.getKnownReleases", () => {
  it("returns the most recent non-suppressed releases, capped at 10", async () => {
    const db = createTestDb();
    await seed(db);
    const rows = Array.from({ length: 12 }, (_, i) => ({
      id: `rel_known_${String(i).padStart(2, "0")}`,
      sourceId: SRC_ID,
      title: `Release ${i}`,
      version: `1.${i}.0`,
      content: "body",
      url: `${PAGE}#v1-${i}`,
      publishedAt: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      contentChars: 4,
      contentTokens: 1,
    }));
    // Suppressed rows must be excluded, mirroring the known-releases route.
    rows[11] = { ...rows[11]!, suppressed: true } as (typeof rows)[number];
    await db.insert(releases).values(rows);

    const p = mkPersister(db);
    const src = (await p.getSource(SRC_ID))!;
    const known = await p.getKnownReleases(src);
    expect(known.length).toBe(10);
    // Newest first; the suppressed newest row (index 11) is excluded.
    expect(known[0]!.title).toBe("Release 10");
    expect(known[0]!.version).toBe("1.10.0");
    expect(known[0]!.publishedAt).toBe("2026-06-11T00:00:00.000Z");
  });
});

describe("d1ScrapePersister.insertReleases", () => {
  const entries: MappedEntry[] = [
    {
      title: "Dark mode",
      content: "# Dark mode\n\nFull body.",
      url: `${PAGE}#dark-mode`,
      version: "2.0.0",
      publishedAt: new Date("2026-07-01T00:00:00.000Z"),
      media: [{ type: "image", url: "https://example.com/shot.png" }],
    },
    {
      title: "Bug fixes",
      content: "Assorted fixes.",
      url: `${PAGE}#bug-fixes`,
    },
  ];

  it("writes rows, returns ids, and does not set embeddedAt", async () => {
    const db = createTestDb();
    await seed(db);
    const p = mkPersister(db);
    const src = (await p.getSource(SRC_ID))!;

    const result = await p.insertReleases(src, entries);
    expect(result.inserted).toBe(2);
    expect(result.insertedIds.length).toBe(2);

    const stored = await db.select().from(releases).where(eq(releases.sourceId, SRC_ID));
    expect(stored.length).toBe(2);
    const dark = stored.find((r) => r.title === "Dark mode")!;
    expect(result.insertedIds).toContain(dark.id);
    expect(dark.version).toBe("2.0.0");
    expect(dark.publishedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(JSON.parse(dark.media ?? "[]")).toEqual([
      { type: "image", url: "https://example.com/shot.png" },
    ]);
    // Embed is skipped (workflow runs it as a durable step) — no embeddedAt.
    for (const r of stored) expect(r.embeddedAt).toBeNull();
  });

  it("returns an empty result without touching the DB for an empty batch", async () => {
    const db = createTestDb();
    await seed(db);
    const p = mkPersister(db);
    const src = (await p.getSource(SRC_ID))!;
    expect(await p.insertReleases(src, [])).toEqual({ inserted: 0, insertedIds: [] });
  });
});

describe("d1ScrapePersister.updateSourceAfterFetch", () => {
  it("resets the fetch-completion counters", async () => {
    const db = createTestDb();
    await seed(db);
    await db
      .update(sources)
      .set({
        changeDetectedAt: "2026-07-01T00:00:00.000Z",
        consecutiveErrors: 3,
        consecutiveNoChange: 2,
        nextFetchAfter: "2026-07-09T00:00:00.000Z",
      })
      .where(eq(sources.id, SRC_ID));

    const p = mkPersister(db);
    const src = (await p.getSource(SRC_ID))!;
    await p.updateSourceAfterFetch(src);

    const [after] = await db.select().from(sources).where(eq(sources.id, SRC_ID));
    expect(after!.lastFetchedAt).not.toBeNull();
    expect(after!.changeDetectedAt).toBeNull();
    expect(after!.consecutiveErrors).toBe(0);
    expect(after!.consecutiveNoChange).toBe(0);
    expect(after!.nextFetchAfter).toBeNull();
  });
});

describe("d1ScrapePersister.writeFetchLog", () => {
  it("writes a fetch_log row carrying the sessionId", async () => {
    const db = createTestDb();
    await seed(db);
    await mkPersister(db).writeFetchLog(SRC_ID, {
      releasesFound: 3,
      releasesInserted: 2,
      durationMs: 1234,
      status: "success",
    });
    const rows = await db.select().from(fetchLog);
    expect(rows.length).toBe(1);
    expect(rows[0]!.sourceId).toBe(SRC_ID);
    expect(rows[0]!.sessionId).toBe("sess_test");
    expect(rows[0]!.releasesInserted).toBe(2);
  });

  it("swallows a forced insert failure (best-effort)", async () => {
    const broken = new Proxy(
      {},
      {
        get() {
          throw new Error("db exploded");
        },
      },
    ) as unknown as TestDb;
    await expect(
      mkPersister(broken).writeFetchLog(SRC_ID, {
        releasesFound: 0,
        releasesInserted: 0,
        durationMs: 1,
        status: "error",
        error: "boom",
      }),
    ).resolves.toBeUndefined();
  });
});

const fakeR2 = () => {
  const puts: string[] = [];
  return {
    puts,
    binding: {
      put: async (key: string) => {
        puts.push(key);
      },
      get: async () => null,
      head: async () => null,
    },
  };
};

describe("d1ScrapePersister.captureRawSnapshot", () => {
  it("no-ops when captureRawSnapshots is off", async () => {
    const db = createTestDb();
    await seed(db);
    const r2 = fakeR2();
    const env = { ...bareEnv, RAW_SNAPSHOTS: r2.binding } as unknown as D1PersisterEnv;
    const p = mkPersister(db, { env, captureRawSnapshots: false });
    const src = (await p.getSource(SRC_ID))!;
    await p.captureRawSnapshot(src, "# some body");
    expect(r2.puts.length).toBe(0);
    expect((await db.select().from(sourceRawSnapshots)).length).toBe(0);
  });

  it("no-ops on an empty body even when enabled", async () => {
    const db = createTestDb();
    await seed(db);
    const r2 = fakeR2();
    const env = { ...bareEnv, RAW_SNAPSHOTS: r2.binding } as unknown as D1PersisterEnv;
    const p = mkPersister(db, { env, captureRawSnapshots: true });
    const src = (await p.getSource(SRC_ID))!;
    await p.captureRawSnapshot(src, "   \n ");
    expect(r2.puts.length).toBe(0);
  });

  it("stores the snapshot when enabled, and never throws on failure", async () => {
    const db = createTestDb();
    await seed(db);
    const r2 = fakeR2();
    const env = { ...bareEnv, RAW_SNAPSHOTS: r2.binding } as unknown as D1PersisterEnv;
    const p = mkPersister(db, { env, captureRawSnapshots: true });
    const src = (await p.getSource(SRC_ID))!;
    await p.captureRawSnapshot(src, "# raw markdown body");
    expect(r2.puts.length).toBe(1);
    const rows = await db.select().from(sourceRawSnapshots);
    expect(rows.length).toBe(1);
    expect(rows[0]!.sourceId).toBe(SRC_ID);
    expect(rows[0]!.format).toBe("markdown");

    // Unbound bucket → silent no-op, not a throw (mirrors the route's `no_binding`).
    const pNoBucket = mkPersister(db, { env: bareEnv, captureRawSnapshots: true });
    await expect(pNoBucket.captureRawSnapshot(src, "# body")).resolves.toBeUndefined();

    // A storage failure is swallowed (best-effort, must never throw).
    const failingEnv = {
      ...bareEnv,
      RAW_SNAPSHOTS: {
        put: async () => {
          throw new Error("r2 down");
        },
        get: async () => null,
        head: async () => null,
      },
    } as unknown as D1PersisterEnv;
    const pFailing = mkPersister(db, { env: failingEnv, captureRawSnapshots: true });
    await expect(pFailing.captureRawSnapshot(src, "# another body")).resolves.toBeUndefined();
  });
});
