/**
 * GET /v1/releases/:id exposes `ogImageUrl` (#2066): the absolute
 * media.releases.sh URL for a release's mirrored OpenGraph image, resolved
 * from `releases.metadata.ogImage.key` via `MEDIA_ORIGIN`. Null when no
 * mirrored image exists yet (unmirrored release, or `MEDIA_ORIGIN` unset).
 */
import { describe, it, expect } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { sourceRoutes } from "../src/routes/sources.js";
import { createTestDb, createTestApp } from "./setup";

const REL_ID = "rel_abcdefghijklmnopqrstu";

async function seed(db: ReturnType<typeof createTestDb>, metadata?: string) {
  await db
    .insert(organizations)
    .values({ id: "org_acme", slug: "acme", name: "Acme", category: "cloud" });
  await db.insert(sources).values({
    id: "src_acme_feed",
    slug: "acme-feed",
    name: "Acme Feed",
    type: "feed",
    url: "https://acme.test/feed",
    orgId: "org_acme",
  });
  await db.insert(releases).values({
    id: REL_ID,
    sourceId: "src_acme_feed",
    title: "Acme 2.0",
    content: "Notes",
    url: "https://acme.test/2-0",
    publishedAt: "2026-06-01T00:00:00Z",
    ...(metadata !== undefined ? { metadata } : {}),
  });
}

describe("GET /v1/releases/:id ogImageUrl", () => {
  it("resolves an absolute media URL when metadata.ogImage is stamped", async () => {
    const db = createTestDb();
    await seed(
      db,
      JSON.stringify({ ogImage: { key: `og/release/${REL_ID}-abc123.png`, hash: "abc123" } }),
    );
    const app = createTestApp(db, sourceRoutes, {
      env: { MEDIA_ORIGIN: "https://media.releases.sh" },
    });

    const res = await app(new Request(`http://x/v1/releases/${REL_ID}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ogImageUrl?: string | null };
    expect(body.ogImageUrl).toBe(`https://media.releases.sh/og/release/${REL_ID}-abc123.png`);
  });

  it("is null when no ogImage has been mirrored yet", async () => {
    const db = createTestDb();
    await seed(db);
    const app = createTestApp(db, sourceRoutes, {
      env: { MEDIA_ORIGIN: "https://media.releases.sh" },
    });

    const res = await app(new Request(`http://x/v1/releases/${REL_ID}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ogImageUrl?: string | null };
    expect(body.ogImageUrl).toBeNull();
  });

  it("is null when metadata is malformed", async () => {
    const db = createTestDb();
    await seed(db, "not json");
    const app = createTestApp(db, sourceRoutes, {
      env: { MEDIA_ORIGIN: "https://media.releases.sh" },
    });

    const res = await app(new Request(`http://x/v1/releases/${REL_ID}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ogImageUrl?: string | null };
    expect(body.ogImageUrl).toBeNull();
  });
});
