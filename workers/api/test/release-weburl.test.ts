/**
 * Friendly release URLs on the API surface:
 * - GET /v1/releases/:id accepts the `rel_<id>-<slug>` form (slug is
 *   decorative; the rel_ ID is positional — rel_ + 21 chars) and returns the
 *   same release as the bare ID.
 * - The detail response carries `webUrl` = web base + releasePath (slug
 *   derived from titleShort → titleGenerated → title → version).
 * - Latest-list items carry `webUrl`; `mapLatestRowToReleaseItem` only emits
 *   it when a web base is passed.
 *
 * Pure releasePath/parseReleaseParam behavior is covered in
 * tests/unit/release-slug.test.ts — this file covers the route/query seams.
 */
import { describe, it, expect } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { sourceRoutes } from "../src/routes/sources.js";
import { releaseRoutes } from "../src/routes/releases.js";
import { mapLatestRowToReleaseItem, type LatestReleaseRow } from "../src/queries/releases.js";
import { createTestDb, createTestApp } from "./setup";

// rel_ + exactly 21 chars — parseReleaseParam only strips a slug from the
// canonical nanoid shape, so the seeded ID must match it.
const REL_ID = "rel_abcdefghijklmnopqrstu";

async function seed(db: ReturnType<typeof createTestDb>) {
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
    titleShort: "Acme improves widgets",
    version: "2.0.0",
    content: "Notes",
    url: "https://acme.test/2-0",
    publishedAt: "2026-06-01T00:00:00Z",
  });
}

describe("GET /v1/releases/:id slug-tolerant lookup", () => {
  it("returns the same release for the bare ID and a stale-slug form", async () => {
    const db = createTestDb();
    await seed(db);
    const app = createTestApp(db, sourceRoutes);

    const bare = await app(new Request(`http://x/v1/releases/${REL_ID}`));
    const slugged = await app(new Request(`http://x/v1/releases/${REL_ID}-some-stale-slug`));
    expect(bare.status).toBe(200);
    expect(slugged.status).toBe(200);

    const bareBody = (await bare.json()) as { id: string };
    const sluggedBody = (await slugged.json()) as { id: string };
    expect(bareBody.id).toBe(REL_ID);
    expect(sluggedBody).toEqual(bareBody);
  });

  it("includes webUrl with the slug derived from titleShort", async () => {
    const db = createTestDb();
    await seed(db);
    const app = createTestApp(db, sourceRoutes);

    const res = await app(new Request(`http://x/v1/releases/${REL_ID}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { webUrl?: string };
    expect(body.webUrl).toBe(`https://releases.sh/release/${REL_ID}-acme-improves-widgets`);
  });

  it("builds webUrl from WEB_BASE_URL, stripping a trailing slash", async () => {
    const db = createTestDb();
    await seed(db);
    const app = createTestApp(db, sourceRoutes, {
      env: { WEB_BASE_URL: "https://web.example/" },
    });

    const res = await app(new Request(`http://x/v1/releases/${REL_ID}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { webUrl?: string };
    expect(body.webUrl).toBe(`https://web.example/release/${REL_ID}-acme-improves-widgets`);
  });
});

describe("GET /v1/releases/latest webUrl", () => {
  it("includes webUrl on list items", async () => {
    const db = createTestDb();
    await seed(db);
    const app = createTestApp(db, releaseRoutes);

    // Filter by source so the request bypasses the KV latest-cache path
    // (no LATEST_CACHE binding in the test env).
    const res = await app(new Request("http://x/v1/releases/latest?source=acme-feed"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { releases: Array<{ id: string; webUrl?: string }> };
    expect(body.releases).toHaveLength(1);
    expect(body.releases[0].id).toBe(REL_ID);
    expect(body.releases[0].webUrl).toBe(
      `https://releases.sh/release/${REL_ID}-acme-improves-widgets`,
    );
  });
});

describe("mapLatestRowToReleaseItem webUrl", () => {
  const row: LatestReleaseRow = {
    id: REL_ID,
    version: "2.0.0",
    title: "Acme 2.0",
    summary: null,
    title_generated: null,
    title_short: "Acme improves widgets",
    breaking: null,
    published_at: "2026-06-01T00:00:00Z",
    url: "https://acme.test/2-0",
    media: null,
    source_slug: "acme-feed",
    source_name: "Acme Feed",
    source_type: "feed",
    org_slug: "acme",
    org_name: "Acme",
    org_avatar_url: null,
    org_github_handle: null,
    product_slug: null,
    product_name: null,
    type: "feature",
    coverage_count: 0,
    content_chars: null,
    content_tokens: null,
  };

  it("emits webUrl when a web base is passed", () => {
    const item = mapLatestRowToReleaseItem(row, "", "https://releases.sh");
    expect(item.webUrl).toBe(`https://releases.sh/release/${REL_ID}-acme-improves-widgets`);
  });

  it("omits webUrl when no web base is passed", () => {
    const item = mapLatestRowToReleaseItem(row, "");
    expect(item.webUrl).toBeUndefined();
  });
});
