/**
 * Server-side scrape title-dedup insert guard (#1410).
 *
 * Scrape releases are stored with synthesized anchor URLs (`<page>#<slug>`), and
 * the slug differs between write paths (a local backfill anchors off the section
 * heading `#may-2026`; the steady-state cron's mapEntries anchors off
 * slug(version??title)). Two anchors for the same entry don't collide under
 * UNIQUE(source_id, url), so the release lands twice. This pins the normalized-
 * title guard at the write boundaries: same-source same-title is collapsed for
 * scrape sources, left untouched for feed/github, and kill-switchable.
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

const mkApp = (db: TestDb, env: Record<string, unknown> = {}) =>
  createTestApp(db, [sourceRoutes], { env: { STATUS_HUB: statusHubStub, ...env } });

const PAGE = "https://help.gong.io/docs/whats-new-in-gong-data-cloud";

async function seed(db: TestDb, type: "scrape" | "feed" = "scrape") {
  await db
    .insert(organizations)
    .values([{ id: "org_g", slug: "gong", name: "Gong", category: "developer-tools" }]);
  await db.insert(sources).values([
    {
      id: "src_g",
      slug: "gong-data-cloud",
      name: "Gong Data Cloud",
      type,
      url: PAGE,
      orgId: "org_g",
    },
  ]);
  // An existing (backfilled) row anchored off the month heading.
  await db.insert(releases).values([
    {
      id: "rel_existing",
      sourceId: "src_g",
      title: "Numeric field type updates",
      content: "Existing content.",
      url: `${PAGE}#may-2026`,
      contentChars: 17,
      contentTokens: 4,
    },
  ]);
}

// Cron/mapEntries would re-extract the SAME entry with a slug(title) anchor.
const DUP = {
  title: "Numeric field type updates",
  content: "Re-extracted.",
  url: `${PAGE}#numeric-field-type-updates`,
};
const FRESH = { title: "Call skip codes", content: "New entry.", url: `${PAGE}#call-skip-codes` };

const batch = (db: TestDb, body: unknown, env?: Record<string, unknown>) =>
  mkApp(
    db,
    env,
  )(
    new Request("https://api/v1/sources/src_g/releases/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const single = (db: TestDb, body: unknown) =>
  mkApp(db)(
    new Request("https://api/v1/sources/src_g/releases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("POST /sources/:id/releases/batch — scrape title-dedup (#1410)", () => {
  it("drops a same-title re-extraction under a different anchor, keeps fresh entries", async () => {
    const db = mkDb();
    await seed(db, "scrape");

    const res = await batch(db, { releases: [DUP, FRESH] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { inserted: number }).inserted).toBe(1);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_g"));
    // existing #may-2026 + the fresh #call-skip-codes — NOT the dup.
    expect(new Set(rows.map((r) => r.url))).toEqual(
      new Set([`${PAGE}#may-2026`, `${PAGE}#call-skip-codes`]),
    );
  });

  it("does NOT title-collapse a non-scrape (feed) source", async () => {
    const db = mkDb();
    await seed(db, "feed");

    const res = await batch(db, { releases: [DUP, FRESH] });
    expect(((await res.json()) as { inserted: number }).inserted).toBe(2);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_g"));
    expect(rows).toHaveLength(3); // existing + both inserted (distinct URLs)
  });

  it("kill switch (SCRAPE_TITLE_DEDUP_DISABLED) restores verbatim insert", async () => {
    const db = mkDb();
    await seed(db, "scrape");

    const res = await batch(
      db,
      { releases: [DUP, FRESH] },
      { SCRAPE_TITLE_DEDUP_DISABLED: "true" },
    );
    expect(((await res.json()) as { inserted: number }).inserted).toBe(2);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_g"));
    expect(rows).toHaveLength(3); // dup inserted under its distinct anchor
  });
});

describe("POST /sources/:id/releases — scrape title-dedup (#1410)", () => {
  it("skips a single insert whose title duplicates an existing entry", async () => {
    const db = mkDb();
    await seed(db, "scrape");

    const res = await single(db, DUP);
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      skipped: true,
      reason: "title_duplicate",
    });

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_g"));
    expect(rows).toHaveLength(1); // only the existing row
  });

  it("inserts a single release with a genuinely new title", async () => {
    const db = mkDb();
    await seed(db, "scrape");

    const res = await single(db, FRESH);
    expect(res.status).toBe(201);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_g"));
    expect(rows).toHaveLength(2);
  });
});
