/**
 * Server-side `feedUrlDeny` insert guard (#1335).
 *
 * #1334 wired `feedUrlDeny` into the cron poll-fetch direct path only. Every
 * managed-agent fetch path (operator `admin source fetch`, scrape summary-only
 * crawl delegation, the in-worker scrape pipeline) instead writes through the
 * source-scoped release-insert endpoints — `POST /sources/:id/releases/batch`
 * and the single-insert `POST /sources/:id/releases`. This test pins the
 * defense-in-depth guard at those write boundaries: a release whose URL matches
 * the source's `feedUrlDeny` is never ingested as an active release, regardless
 * of how it arrived.
 */
import { describe, it, expect } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";
import { sourceRoutes } from "../src/routes/sources.js";
import { createTestDb as mkDb, createTestApp, type TestDb } from "./setup";

const statusHubStub = {
  idFromName: () => "stub-id",
  get: () => ({ fetch: async () => new Response("ok", { status: 200 }) }),
};

const mkApp = (db: TestDb) =>
  createTestApp(db, [sourceRoutes], { env: { STATUS_HUB: statusHubStub } });

async function seed(db: TestDb, opts: { feedUrlDeny?: string[] } = {}) {
  await db
    .insert(organizations)
    .values([
      { id: "org_ch", slug: "clickhouse", name: "ClickHouse", category: "developer-tools" },
    ]);
  await db.insert(sources).values([
    {
      id: "src_ch_blog",
      slug: "clickhouse-blog",
      name: "ClickHouse Blog",
      type: "feed",
      url: "https://clickhouse.com/blog",
      orgId: "org_ch",
      metadata: JSON.stringify(opts.feedUrlDeny ? { feedUrlDeny: opts.feedUrlDeny } : {}),
    },
  ]);
}

const batch = (db: TestDb, body: unknown) =>
  mkApp(db)(
    new Request("https://api/v1/sources/src_ch_blog/releases/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const single = (db: TestDb, body: unknown) =>
  mkApp(db)(
    new Request("https://api/v1/sources/src_ch_blog/releases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const EN = { title: "Gala on AWS", content: "x", url: "https://clickhouse.com/blog/gala" };
const JP = { title: "Gala (JP)", content: "x", url: "https://clickhouse.com/blog/gala-jp" };

describe("POST /sources/:id/releases/batch — feedUrlDeny insert guard (#1335)", () => {
  it("drops a release whose URL matches feedUrlDeny, keeps the rest", async () => {
    const db = mkDb();
    await seed(db, { feedUrlDeny: ["-jp$"] });

    const res = await batch(db, { releases: [EN, JP] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { inserted: number }).inserted).toBe(1);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_ch_blog"));
    expect(rows.map((r) => r.url)).toEqual(["https://clickhouse.com/blog/gala"]);
  });

  it("is a no-op when the source has no feedUrlDeny (all inserted)", async () => {
    const db = mkDb();
    await seed(db);

    const res = await batch(db, { releases: [EN, JP] });
    expect(((await res.json()) as { inserted: number }).inserted).toBe(2);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_ch_blog"));
    expect(rows).toHaveLength(2);
  });

  it("inserts 0 when every release in the batch is denied", async () => {
    const db = mkDb();
    await seed(db, { feedUrlDeny: ["-jp$"] });

    const res = await batch(db, { releases: [JP] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { inserted: number }).inserted).toBe(0);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_ch_blog"));
    expect(rows).toHaveLength(0);
  });

  it("returns 400 on a malformed body instead of throwing (releases not an array)", async () => {
    const db = mkDb();
    await seed(db, { feedUrlDeny: ["-jp$"] });

    const res = await batch(db, { releases: "nope" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_request");
  });
});

describe("POST /sources/:id/releases — feedUrlDeny insert guard (#1335)", () => {
  it("skips a single insert whose URL matches feedUrlDeny", async () => {
    const db = mkDb();
    await seed(db, { feedUrlDeny: ["-jp$"] });

    const res = await single(db, JP);
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      skipped: true,
      reason: "url_denied",
    });

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_ch_blog"));
    expect(rows).toHaveLength(0);
  });

  it("inserts a single release whose URL does not match feedUrlDeny", async () => {
    const db = mkDb();
    await seed(db, { feedUrlDeny: ["-jp$"] });

    const res = await single(db, EN);
    expect(res.status).toBe(201);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_ch_blog"));
    expect(rows.map((r) => r.url)).toEqual(["https://clickhouse.com/blog/gala"]);
  });
});
