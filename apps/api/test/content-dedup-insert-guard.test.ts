/**
 * Same-source / same-day body-hash dedup, plus version-line coverage.
 *
 * A scrape re-extract rewords the title and mints a new `#anchor`, so
 * UNIQUE(source_id, url) and title dedup both miss it. The body hash drops
 * that duplicate and leaves a different version or package in place so the
 * version-line clusterer can link it as coverage.
 */
import { describe, it, expect } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { releaseCoverage } from "@releases/core-internal/schema-coverage.js";
import { eq } from "drizzle-orm";
import { sourceRoutes } from "../src/routes/sources.js";
import { createTestDb as mkDb, createTestApp, type TestDb } from "./setup";
import { DECIDED_BY_VERSION_LINE } from "../src/lib/ingest/cluster-version-lines.js";

const statusHubStub = {
  idFromName: () => "stub-id",
  get: () => ({ fetch: async () => new Response("ok", { status: 200 }) }),
};

const mkApp = (db: TestDb) =>
  createTestApp(db, [sourceRoutes], { env: { STATUS_HUB: statusHubStub } });

const PAGE = "https://platform.openai.com/docs/changelog";
const DAY = "2026-10-14T16:00:00.000Z";
const NOTES = `Fixed the timeout that dropped long streaming responses before the client finished reading them. The server now flushes partial chunks and records the request id in the error log.`;

async function seed(db: TestDb) {
  await db
    .insert(organizations)
    .values([{ id: "org_o", slug: "openai", name: "OpenAI", category: "developer-tools" }]);
  await db.insert(sources).values([
    {
      id: "src_o",
      slug: "api-changelog",
      name: "API changelog",
      type: "scrape",
      url: PAGE,
      orgId: "org_o",
    },
  ]);
  await db.insert(releases).values([
    {
      id: "rel_existing",
      sourceId: "src_o",
      title: "Timeout fix for streaming responses",
      content: NOTES,
      url: `${PAGE}#timeout-fix`,
      publishedAt: DAY,
      contentChars: NOTES.length,
      contentTokens: 40,
    },
  ]);
}

const batch = (db: TestDb, body: unknown) =>
  mkApp(db)(
    new Request("https://api/v1/sources/src_o/releases/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const single = (db: TestDb, body: unknown) =>
  mkApp(db)(
    new Request("https://api/v1/sources/src_o/releases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const reworded = {
  title: "Streaming responses no longer time out early",
  content: `## Streaming responses no longer time out early\n\n${NOTES}`,
  url: `${PAGE}#streaming-responses-no-longer-time-out-early`,
  publishedAt: "2026-10-14T22:00:00.000Z",
};

describe("POST /sources/:id/releases/batch — content dedup", () => {
  it("drops a reworded same-day re-extraction under a new anchor", async () => {
    const db = mkDb();
    await seed(db);

    const res = await batch(db, { releases: [reworded] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { inserted: number }).inserted).toBe(0);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_o"));
    expect(rows.map((r) => r.url)).toEqual([`${PAGE}#timeout-fix`]);
  });

  it("inserts a backport and links it as coverage of the higher version", async () => {
    const db = mkDb();
    await seed(db);
    await db.delete(releases).where(eq(releases.sourceId, "src_o"));

    const res = await batch(db, {
      releases: [
        {
          title: "1.2.0",
          version: "1.2.0",
          content: NOTES,
          url: `${PAGE}#1-2-0`,
          publishedAt: DAY,
        },
        {
          title: "1.1.5",
          version: "1.1.5",
          content: NOTES,
          url: `${PAGE}#1-1-5`,
          publishedAt: "2026-10-12T00:00:00.000Z",
        },
      ],
    });
    expect(((await res.json()) as { inserted: number }).inserted).toBe(2);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_o"));
    const byVersion = new Map(rows.map((r) => [r.version, r.id]));
    const links = await db.select().from(releaseCoverage);
    expect(links).toEqual([
      expect.objectContaining({
        canonicalId: byVersion.get("1.2.0"),
        coverageId: byVersion.get("1.1.5"),
        reason: "version-line:backport:1.1.5+1.2.0",
        decidedBy: DECIDED_BY_VERSION_LINE,
      }),
    ]);
  });
});

describe("POST /sources/:id/releases — content dedup", () => {
  it("skips a single insert whose body repeats an existing same-day entry", async () => {
    const db = mkDb();
    await seed(db);

    const res = await single(db, reworded);
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      skipped: true,
      reason: "content_duplicate",
    });
    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_o"));
    expect(rows).toHaveLength(1);
  });
});
