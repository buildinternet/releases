// Smoke tests for POST /v1/workflows/refetch-release.
//
// Covers the gates (typed-id, 404, fragment-URL-without-override, cross-host
// override, URL-collision conflict), the dry-run preview, and the in-place
// write via the `_refetchBodyOverride` / `_refetchExtractOverride` /
// `_refetchPostProcessOverride` test hooks. The single-post extraction itself
// is unit-tested in firecrawl-extract.test.ts; this file proves the HTTP
// wiring and the update semantics (same rel_ id, recomputed sizes/hash,
// nulled AI fields, media-preserving miss).
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations } from "../../../tests/db-helper";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import type { RawRelease } from "@releases/adapters/types.js";

const { Hono } = await import("hono");
const { workflowsRoutes } = await import("../src/routes/workflows.js");

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

function mkApp(db: ReturnType<typeof mkDb>, extra: Record<string, unknown> = {}) {
  const fakeEnv = { DB: db, ...extra };
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", workflowsRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, fakeEnv);
}

const SRC_URL = "https://acme.test/news";

async function seed(
  db: ReturnType<typeof mkDb>,
  release: Partial<typeof releases.$inferInsert> = {},
): Promise<void> {
  await db
    .insert(organizations)
    .values({ id: "org_a", slug: "acme", name: "Acme", category: "developer-tools" });
  await db.insert(sources).values({
    id: "src_a",
    orgId: "org_a",
    slug: "acme-news",
    name: "Acme News",
    type: "scrape",
    url: SRC_URL,
  });
  await db.insert(releases).values({
    id: "rel_thin0000000000000000",
    sourceId: "src_a",
    title: "Teaser title",
    content: "Two-line teaser.",
    url: `${SRC_URL}#teaser-title`,
    publishedAt: "2026-07-01T00:00:00.000Z",
    media: JSON.stringify([{ type: "image", url: "https://acme.test/old.png" }]),
    summary: "old summary",
    titleGenerated: "old generated",
    titleShort: "old short",
    embeddedAt: "2026-07-01T01:00:00.000Z",
    ...release,
  });
}

function post(fetch: (r: Request) => Response | Promise<Response>, body: unknown) {
  return fetch(
    new Request("https://x.test/v1/workflows/refetch-release", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

const FULL_POST: RawRelease = {
  title: "Real Post Title",
  content: "The full canonical body of the post, preserved verbatim across paragraphs.",
  url: `${SRC_URL}/real-post`,
  publishedAt: new Date("2026-07-02T00:00:00.000Z"),
};

const hooks = (post: RawRelease | null = FULL_POST) => ({
  _refetchBodyOverride: { markdown: "# Real Post Title\n\nbody", via: "supplied" },
  _refetchExtractOverride: async () => (post ? [post] : []),
  _refetchPostProcessOverride: async () => {},
});

describe("POST /v1/workflows/refetch-release", () => {
  it("rejects a missing or untyped release id", async () => {
    const db = mkDb();
    for (const body of [{}, { releaseId: "some-slug" }]) {
      // oxlint-disable-next-line no-await-in-loop
      const res = await post(mkApp(db), body);
      expect(res.status).toBe(400);
    }
  });

  it("404s an unknown release id", async () => {
    const db = mkDb();
    const res = await post(mkApp(db), { releaseId: "rel_missing0000000000000" });
    expect(res.status).toBe(404);
  });

  it("400s a fragment-URL release without an explicit url override", async () => {
    const db = mkDb();
    await seed(db);
    const res = await post(mkApp(db, hooks()), { releaseId: "rel_thin0000000000000000" });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: { message: string } };
    expect(error.message).toContain("index anchor");
  });

  it("400s a url override on a different host", async () => {
    const db = mkDb();
    await seed(db);
    const res = await post(mkApp(db, hooks()), {
      releaseId: "rel_thin0000000000000000",
      url: "https://evil.test/news/real-post",
    });
    expect(res.status).toBe(400);
  });

  it("dry-run (default) previews current vs proposed without writing", async () => {
    const db = mkDb();
    await seed(db);
    const res = await post(mkApp(db, hooks()), {
      releaseId: "rel_thin0000000000000000",
      url: `${SRC_URL}/real-post`,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      dryRun: boolean;
      current: { title: string; url: string };
      proposed: { title: string; contentChars: number; url: string };
    };
    expect(json.dryRun).toBe(true);
    expect(json.current.title).toBe("Teaser title");
    expect(json.proposed.title).toBe("Real Post Title");
    expect(json.proposed.url).toBe(`${SRC_URL}/real-post`);
    expect(json.proposed.contentChars).toBe(FULL_POST.content.length);

    const [row] = await db
      .select()
      .from(releases)
      .where(eq(releases.id, "rel_thin0000000000000000"));
    expect(row!.content).toBe("Two-line teaser."); // untouched
  });

  it("writes in place: same id, replaced fields, recomputed sizes, nulled AI fields, rewritten url", async () => {
    const db = mkDb();
    await seed(db);
    const res = await post(mkApp(db, hooks()), {
      releaseId: "rel_thin0000000000000000",
      url: `${SRC_URL}/real-post`,
      dryRun: false,
    });
    expect(res.status).toBe(200);

    const [row] = await db
      .select()
      .from(releases)
      .where(eq(releases.id, "rel_thin0000000000000000"));
    expect(row!.title).toBe("Real Post Title");
    expect(row!.content).toBe(FULL_POST.content);
    expect(row!.contentChars).toBe(FULL_POST.content.length);
    expect(row!.contentTokens).toBeGreaterThan(0);
    expect(row!.contentHash).toBeTruthy();
    expect(row!.url).toBe(`${SRC_URL}/real-post`);
    expect(row!.publishedAt).toBe("2026-07-02T00:00:00.000Z");
    // AI fields nulled so summarize + embed regenerate over the richer body.
    expect(row!.summary).toBeNull();
    expect(row!.titleGenerated).toBeNull();
    expect(row!.titleShort).toBeNull();
    expect(row!.embeddedAt).toBeNull();
    // Extraction returned no media → stored media preserved, not wiped.
    expect(JSON.parse(row!.media as string)).toHaveLength(1);
  });

  it("uses the stored URL directly when it has no fragment", async () => {
    const db = mkDb();
    await seed(db, { url: `${SRC_URL}/already-canonical` });
    const res = await post(mkApp(db, hooks()), {
      releaseId: "rel_thin0000000000000000",
      dryRun: false,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { fetchUrl: string };
    expect(json.fetchUrl).toBe(`${SRC_URL}/already-canonical`);
  });

  it("409s when the url override collides with another release's dedup slot", async () => {
    const db = mkDb();
    await seed(db);
    await db.insert(releases).values({
      id: "rel_other000000000000000",
      sourceId: "src_a",
      title: "Other",
      content: "Other body",
      url: `${SRC_URL}/real-post`,
    });
    const res = await post(mkApp(db, hooks()), {
      releaseId: "rel_thin0000000000000000",
      url: `${SRC_URL}/real-post`,
      dryRun: false,
    });
    expect(res.status).toBe(409);
  });

  it("502s when extraction yields no usable content", async () => {
    const db = mkDb();
    await seed(db);
    const res = await post(mkApp(db, hooks(null)), {
      releaseId: "rel_thin0000000000000000",
      url: `${SRC_URL}/real-post`,
    });
    expect(res.status).toBe(502);
  });

  it("replaces media when extraction returns items (no MEDIA bucket → stored verbatim)", async () => {
    const db = mkDb();
    await seed(db);
    const withMedia: RawRelease = {
      ...FULL_POST,
      media: [{ type: "image", url: "https://acme.test/new-shot.png" }],
    };
    const res = await post(mkApp(db, hooks(withMedia)), {
      releaseId: "rel_thin0000000000000000",
      url: `${SRC_URL}/real-post`,
      dryRun: false,
    });
    expect(res.status).toBe(200);
    const [row] = await db
      .select()
      .from(releases)
      .where(eq(releases.id, "rel_thin0000000000000000"));
    const media = JSON.parse(row!.media as string) as Array<{ url: string }>;
    expect(media).toHaveLength(1);
    expect(media[0]!.url).toBe("https://acme.test/new-shot.png");
  });
});
