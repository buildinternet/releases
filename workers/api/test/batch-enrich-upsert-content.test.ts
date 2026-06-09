/**
 * Batch enrichment mode (`mode: "upsert-content"`) — #1526.
 *
 * The default `/releases/batch` upsert is fill-don't-clobber (#958): once a row
 * has non-empty content, a richer same-URL re-POST is silently ignored, and for
 * scrape sources the title-dedup pre-filter (#1410) can drop same-title rows
 * before the URL upsert even runs. A deliberate second-pass enrichment (e.g.
 * local-ingest: index summaries first, then full detail-page bodies) needs the
 * new content to win. `mode: "upsert-content"` opts into a clobbering upsert and
 * skips the title-dedup pre-filter. This pins both behaviours and confirms the
 * default path is unchanged.
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

const PAGE = "https://help.harvey.ai/release-notes";
const REL_URL = `${PAGE}/dark-mode`;

async function seed(db: TestDb, type: "scrape" | "feed" = "scrape") {
  await db
    .insert(organizations)
    .values([{ id: "org_h", slug: "harvey", name: "Harvey", category: "developer-tools" }]);
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
  // Stub row seeded from the index card — real URL, one-line (non-empty) summary.
  await db.insert(releases).values([
    {
      id: "rel_stub",
      sourceId: "src_h",
      title: "Dark mode",
      content: "One-line index summary.",
      url: REL_URL,
      contentChars: 23,
      contentTokens: 6,
    },
  ]);
}

const FULL = {
  title: "Dark mode",
  content: "# Dark mode\n\nFull detail-page body with the complete changelog prose.",
  url: REL_URL,
  media: JSON.stringify([{ type: "image", url: "https://cdn.sanity.io/shot.png" }]),
};

const batch = (db: TestDb, body: unknown, env?: Record<string, unknown>) =>
  mkApp(
    db,
    env,
  )(
    new Request("https://api/v1/sources/src_h/releases/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("POST /sources/:id/releases/batch — enrich mode (#1526)", () => {
  it("default mode does NOT overwrite existing non-empty content (the #1526 trap)", async () => {
    const db = mkDb();
    await seed(db, "scrape");

    // Same URL + same title → title-dedup keeps it (URL match), but the
    // fill-don't-clobber upsert refuses to overwrite the non-empty content stub.
    // (Media DOES fill, since the stub's media was empty — fill-only fills empties.)
    await batch(db, { releases: [FULL] });

    const [row] = await db.select().from(releases).where(eq(releases.url, REL_URL));
    expect(row!.content).toBe("One-line index summary.");
  });

  it("enrich mode overwrites content + media on a same-URL row", async () => {
    const db = mkDb();
    await seed(db, "scrape");

    const res = await batch(db, { mode: "upsert-content", releases: [FULL] });
    expect(res.status).toBe(200);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_h"));
    expect(rows).toHaveLength(1); // updated in place, not duplicated
    expect(rows[0]!.content).toBe(FULL.content);
    expect(rows[0]!.media).toBe(FULL.media);
    expect(rows[0]!.contentChars).toBeGreaterThan(23);
  });

  it("enrich mode skips title-dedup so a same-title scrape row reaches the upsert", async () => {
    const db = mkDb();
    await seed(db, "scrape");

    // In default mode a NEW-url same-title scrape row is title-dropped; enrich
    // mode skips that pre-filter. Here the URL matches, so it updates in place.
    const res = await batch(db, { mode: "upsert-content", releases: [FULL] });
    const inserted = ((await res.json()) as { inserted: number }).inserted;
    expect(inserted).toBe(1);
  });

  it("enrich mode does not wipe stored content when incoming content is blank", async () => {
    const db = mkDb();
    await seed(db, "scrape");

    await batch(db, {
      mode: "upsert-content",
      releases: [{ title: "Dark mode", content: "", url: REL_URL }],
    });

    const [row] = await db.select().from(releases).where(eq(releases.url, REL_URL));
    expect(row!.content).toBe("One-line index summary.");
  });
});
