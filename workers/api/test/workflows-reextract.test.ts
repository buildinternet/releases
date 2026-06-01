// Smoke tests for POST /v1/workflows/reextract-source (#1284).
//
// Re-extracts releases from a stored raw snapshot with no live scrape: resolve
// source → resolve snapshot (latest or by id) → load body from R2 → run the
// SAME windowed extract/ingest machinery as backfill-source (via the shared
// executeWindowedBackfill helper) with via="snapshot". The deep extract/ingest
// logic is unit-tested elsewhere; this proves the HTTP + snapshot-resolution
// wiring via the `_backfillExtractOverride` hook.
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import { organizations, sources, sourceRawSnapshots } from "@buildinternet/releases-core/schema";

const { Hono } = await import("hono");
const { workflowsRoutes } = await import("../src/routes/workflows.js");

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  sqlite.exec("DELETE FROM collections");
  return db;
}

/** R2 stub holding bodies keyed by r2Key; only `get` is exercised by reextract. */
function fakeR2(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    put: async (k: string, v: string) => void store.set(k, v),
    get: async (k: string) => (store.has(k) ? { text: async () => store.get(k)! } : null),
    head: async (k: string) => (store.has(k) ? {} : null),
  };
}

function mkApp(db: ReturnType<typeof mkDb>, extra: Record<string, unknown> = {}) {
  const fakeEnv = { DB: db, ...extra };
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", workflowsRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, fakeEnv);
}

async function seedScrapeSource(db: ReturnType<typeof mkDb>): Promise<void> {
  await db
    .insert(organizations)
    .values({ id: "org_a", slug: "acme", name: "Acme", category: "developer-tools" });
  await db.insert(sources).values({
    id: "src_scrape",
    orgId: "org_a",
    slug: "acme-blog",
    name: "Acme Blog",
    type: "scrape",
    url: "https://acme.test/changelog",
  });
}

async function seedSnapshot(
  db: ReturnType<typeof mkDb>,
  row: { id: string; r2Key: string; contentHash: string; bytes: number; createdAt: string },
): Promise<void> {
  await db.insert(sourceRawSnapshots).values({
    id: row.id,
    sourceId: "src_scrape",
    r2Key: row.r2Key,
    contentHash: row.contentHash,
    format: "markdown",
    bytes: row.bytes,
    createdAt: row.createdAt,
  });
}

function post(fetch: (r: Request) => Response | Promise<Response>, body: unknown) {
  return fetch(
    new Request("https://x.test/v1/workflows/reextract-source", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

const okOverride = (sink?: { markdown?: string }) => async (md: string) => {
  if (sink) sink.markdown = md;
  return {
    releases: [
      { title: "v1", content: "b", url: "https://x#a", publishedAt: new Date("2024-01-01") },
      { title: "v2", content: "b", url: "https://x#b", publishedAt: new Date("2024-02-01") },
    ],
    windows: 1,
    cappedAtWindow: false,
    droppedChars: 0,
  };
};

describe("POST /v1/workflows/reextract-source", () => {
  it("rejects a bare slug with bare_slug_rejected", async () => {
    const db = mkDb();
    await seedScrapeSource(db);
    const res = await post(mkApp(db), { sourceId: "acme-blog" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bare_slug_rejected");
  });

  it("404s an unknown source id", async () => {
    const db = mkDb();
    const res = await post(mkApp(db), { sourceId: "src_missing" });
    expect(res.status).toBe(404);
  });

  it("404s when the source has no snapshot", async () => {
    const db = mkDb();
    await seedScrapeSource(db);
    const R2 = fakeR2();
    const res = await post(mkApp(db, { RAW_SNAPSHOTS: R2 }), { sourceId: "src_scrape" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("no_snapshot");
  });

  it("503s when RAW_SNAPSHOTS is unbound", async () => {
    const db = mkDb();
    await seedScrapeSource(db);
    await seedSnapshot(db, {
      id: "raw_1",
      r2Key: "sources/src_scrape/raw/h1.md",
      contentHash: "h1",
      bytes: 4,
      createdAt: "2024-05-01T00:00:00.000Z",
    });
    const res = await post(mkApp(db), { sourceId: "src_scrape" });
    expect(res.status).toBe(503);
  });

  it("410s when the snapshot body is gone from R2 (expired)", async () => {
    const db = mkDb();
    await seedScrapeSource(db);
    await seedSnapshot(db, {
      id: "raw_1",
      r2Key: "sources/src_scrape/raw/missing.md",
      contentHash: "h1",
      bytes: 4,
      createdAt: "2024-05-01T00:00:00.000Z",
    });
    // R2 has no object at that key.
    const res = await post(mkApp(db, { RAW_SNAPSHOTS: fakeR2() }), { sourceId: "src_scrape" });
    expect(res.status).toBe(410);
    expect(((await res.json()) as { error: string }).error).toBe("snapshot_expired");
  });

  it("re-extracts the LATEST snapshot by default (via=snapshot, dryRun no writes)", async () => {
    const db = mkDb();
    await seedScrapeSource(db);
    await seedSnapshot(db, {
      id: "raw_old",
      r2Key: "sources/src_scrape/raw/old.md",
      contentHash: "hold",
      bytes: 3,
      createdAt: "2024-05-01T00:00:00.000Z",
    });
    await seedSnapshot(db, {
      id: "raw_new",
      r2Key: "sources/src_scrape/raw/new.md",
      contentHash: "hnew",
      bytes: 3,
      createdAt: "2024-06-01T00:00:00.000Z",
    });
    const R2 = fakeR2({
      "sources/src_scrape/raw/old.md": "# OLD body",
      "sources/src_scrape/raw/new.md": "# NEW body",
    });
    const sink: { markdown?: string } = {};
    const fetch = mkApp(db, { RAW_SNAPSHOTS: R2, _backfillExtractOverride: okOverride(sink) });

    const res = await post(fetch, { sourceId: "src_scrape", dryRun: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      via: string;
      extracted: number;
      deduped: number;
      dryRun: boolean;
      snapshot: { id: string; contentHash: string; capturedAt: string };
    };
    expect(body.via).toBe("snapshot");
    expect(body.dryRun).toBe(true);
    expect(body.extracted).toBe(2);
    expect(body.snapshot.id).toBe("raw_new");
    expect(body.snapshot.contentHash).toBe("hnew");
    expect(body.snapshot.capturedAt).toBe("2024-06-01T00:00:00.000Z");
    // Loaded the latest body, not the older one.
    expect(sink.markdown).toBe("# NEW body");
  });

  it("re-extracts a specific snapshotId when supplied", async () => {
    const db = mkDb();
    await seedScrapeSource(db);
    await seedSnapshot(db, {
      id: "raw_old",
      r2Key: "sources/src_scrape/raw/old.md",
      contentHash: "hold",
      bytes: 3,
      createdAt: "2024-05-01T00:00:00.000Z",
    });
    await seedSnapshot(db, {
      id: "raw_new",
      r2Key: "sources/src_scrape/raw/new.md",
      contentHash: "hnew",
      bytes: 3,
      createdAt: "2024-06-01T00:00:00.000Z",
    });
    const R2 = fakeR2({
      "sources/src_scrape/raw/old.md": "# OLD body",
      "sources/src_scrape/raw/new.md": "# NEW body",
    });
    const sink: { markdown?: string } = {};
    const fetch = mkApp(db, { RAW_SNAPSHOTS: R2, _backfillExtractOverride: okOverride(sink) });

    const res = await post(fetch, { sourceId: "src_scrape", snapshotId: "raw_old", dryRun: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { snapshot: { id: string } };
    expect(body.snapshot.id).toBe("raw_old");
    expect(sink.markdown).toBe("# OLD body");
  });

  it("404s a snapshotId that exists but belongs to a different source", async () => {
    const db = mkDb();
    await seedScrapeSource(db);
    // A second scrape source under the same org, with its own snapshot.
    await db.insert(sources).values({
      id: "src_other",
      orgId: "org_a",
      slug: "other-blog",
      name: "Other Blog",
      type: "scrape",
      url: "https://other.test/changelog",
    });
    await db.insert(sourceRawSnapshots).values({
      id: "raw_other",
      sourceId: "src_other",
      r2Key: "sources/src_other/raw/other.md",
      contentHash: "hother",
      format: "markdown",
      bytes: 3,
      createdAt: "2024-06-01T00:00:00.000Z",
    });
    const R2 = fakeR2({ "sources/src_other/raw/other.md": "# OTHER body" });
    // raw_other exists, but is scoped to src_other — re-extracting it via
    // src_scrape must 404 (the `eq(sourceId)` clause), never reach another
    // source's body.
    const res = await post(mkApp(db, { RAW_SNAPSHOTS: R2 }), {
      sourceId: "src_scrape",
      snapshotId: "raw_other",
    });
    expect(res.status).toBe(404);
  });
});
