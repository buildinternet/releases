/**
 * Characterization tests for the batch release upsert (issue #1652).
 *
 * `POST /v1/sources/:slug/releases/batch` (and its org-scoped sibling) is the
 * primary release-write path — used by cron, managed-agent fetch sessions,
 * and local-ingest. This suite pins CURRENT insert/dedup/upsert behavior via
 * real Hono route invocations against a migrated test DB, keyed off the
 * `UNIQUE(source_id, url)` constraint and the `RELEASE_URL_UPSERT` fill-only
 * conflict rule (packages/core-internal/src/release-upsert.ts).
 */
import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { sourceRoutes } from "../src/routes/sources.js";
import { createTestDb as mkDb, createTestApp, type TestDb } from "./setup";

const statusHubStub = {
  idFromName: () => "stub-id",
  get: () => ({ fetch: async () => new Response("ok", { status: 200 }) }),
};

const mkApp = (db: TestDb) =>
  createTestApp(db, [sourceRoutes], { env: { STATUS_HUB: statusHubStub } });

const ORG = { id: "org_h", slug: "harvey", name: "Harvey", category: "developer-tools" };
const PAGE = "https://help.harvey.ai/release-notes";

async function seed(db: TestDb, type: "feed" | "scrape" = "feed") {
  await db.insert(organizations).values([ORG]);
  await db.insert(sources).values([
    {
      id: "src_h",
      slug: "harvey-release-notes",
      name: "Harvey",
      type,
      url: PAGE,
      orgId: "org_h",
    },
  ]);
}

const batch = (db: TestDb, body: unknown, path = "/sources/src_h/releases/batch") =>
  mkApp(db)(
    new Request(`https://api/v1${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

function rel(n: number, content = `Body ${n}`) {
  return {
    title: `Release ${n}`,
    content,
    url: `${PAGE}/${n}`,
  };
}

describe("POST /v1/sources/:slug/releases/batch — insert", () => {
  it("inserts N new releases with response counts matching", async () => {
    const db = mkDb();
    await seed(db);

    const res = await batch(db, { releases: [rel(1), rel(2), rel(3)] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { inserted: number; total: number };
    expect(body.inserted).toBe(3);
    expect(body.total).toBe(3);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_h"));
    expect(rows).toHaveLength(3);
  });

  it("reaches the same handler via the org-scoped path", async () => {
    const db = mkDb();
    await seed(db);

    const res = await batch(
      db,
      { releases: [rel(1)] },
      "/orgs/harvey/sources/harvey-release-notes/releases/batch",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { inserted: number };
    expect(body.inserted).toBe(1);
  });
});

describe("POST /v1/sources/:slug/releases/batch — dedup on (source_id, url)", () => {
  it("re-POSTing the identical payload inserts 0 with no duplicate rows", async () => {
    const db = mkDb();
    await seed(db);

    const payload = { releases: [rel(1), rel(2)] };
    const first = await batch(db, payload);
    expect(((await first.json()) as { inserted: number }).inserted).toBe(2);

    const second = await batch(db, payload);
    const secondBody = (await second.json()) as { inserted: number; total: number };
    expect(secondBody.inserted).toBe(0);
    expect(secondBody.total).toBe(2);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_h"));
    expect(rows).toHaveLength(2);
  });
});

describe("POST /v1/sources/:slug/releases/batch — RELEASE_URL_UPSERT fill-don't-clobber", () => {
  it("backfills content on a same-URL collision when the stored row's content is empty", async () => {
    const db = mkDb();
    await seed(db);
    // Seed a stub row directly with empty content, same URL the batch will re-POST.
    await db.insert(releases).values({
      id: "rel_stub",
      sourceId: "src_h",
      title: "Dark mode",
      content: "",
      url: `${PAGE}/dark-mode`,
    });

    const res = await batch(db, {
      releases: [
        { title: "Dark mode", content: "Full body now available.", url: `${PAGE}/dark-mode` },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { inserted: number };
    // The conditional WHERE only affects rows where the update actually
    // applies, so a fill-backfill still counts as "inserted" in RETURNING.
    expect(body.inserted).toBe(1);

    const [row] = await db.select().from(releases).where(eq(releases.id, "rel_stub"));
    expect(row!.content).toBe("Full body now available.");
  });

  it("characterizes current behavior: does NOT overwrite existing non-empty content on a same-URL re-POST", async () => {
    const db = mkDb();
    await seed(db);
    await db.insert(releases).values({
      id: "rel_stub2",
      sourceId: "src_h",
      title: "Dark mode",
      content: "Original one-line summary.",
      url: `${PAGE}/dark-mode-2`,
    });

    const res = await batch(db, {
      releases: [
        {
          title: "Dark mode",
          content: "A much richer re-extraction that should be discarded by fill-only.",
          url: `${PAGE}/dark-mode-2`,
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { inserted: number };
    // The WHERE clause excludes this row from RETURNING because neither the
    // content-empty nor media-empty backfill condition applies — a routine
    // re-fetch of a URL that already has content is a true no-op.
    expect(body.inserted).toBe(0);

    const [row] = await db.select().from(releases).where(eq(releases.id, "rel_stub2"));
    expect(row!.content).toBe("Original one-line summary.");
  });

  it("mode=upsert-content clobbers existing content on the same URL (deliberate enrichment pass)", async () => {
    const db = mkDb();
    await seed(db, "scrape");
    await db.insert(releases).values({
      id: "rel_stub3",
      sourceId: "src_h",
      title: "Dark mode",
      content: "Original one-line summary.",
      url: `${PAGE}/dark-mode-3`,
    });

    const res = await batch(db, {
      mode: "upsert-content",
      releases: [
        { title: "Dark mode", content: "Full detail-page body.", url: `${PAGE}/dark-mode-3` },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { inserted: number };
    expect(body.inserted).toBe(1);

    const [row] = await db.select().from(releases).where(eq(releases.id, "rel_stub3"));
    expect(row!.content).toBe("Full detail-page body.");
  });
});

describe("POST /v1/sources/:slug/releases/batch — chunked insert (D1 100-bind-param cap)", () => {
  it("a batch larger than one chunk (20 rows, chunk size 5) lands every row", async () => {
    const db = mkDb();
    await seed(db);

    const many = Array.from({ length: 20 }, (_, i) => rel(i));
    const res = await batch(db, { releases: many });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { inserted: number; total: number };
    expect(body.inserted).toBe(20);
    expect(body.total).toBe(20);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_h"));
    expect(rows).toHaveLength(20);
    // Every URL landed exactly once — no cross-chunk collisions or gaps.
    const urls = new Set(rows.map((r) => r.url));
    expect(urls.size).toBe(20);
  });
});

describe("POST /v1/sources/:slug/releases/batch — malformed body", () => {
  it("400s when releases is not an array", async () => {
    const db = mkDb();
    await seed(db);

    const res = await batch(db, { releases: "nope" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  it("404s when the source does not exist", async () => {
    const db = mkDb();
    const res = await batch(db, { releases: [rel(1)] });
    expect(res.status).toBe(404);
  });
});
