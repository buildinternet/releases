/**
 * Exercises the sitemap route against an in-memory bun:sqlite DB wired to
 * a Hono app — same `app.fetch()` pattern used across `workers/api/test/`.
 */

import { describe, test, expect, beforeEach, afterAll, beforeAll } from "bun:test";
import { Hono } from "hono";
import { createTestDb, clearAllTables, type TestDatabase } from "../db-helper.js";
import {
  organizations,
  sources,
  products,
  releases,
  collections,
} from "@buildinternet/releases-core/schema";
import { sitemapRoutes } from "../../workers/api/src/routes/sitemap.js";

let testDatabase: TestDatabase;
let app: Hono;

type SitemapResponse = {
  orgs: { slug: string; lastActivity: string | null }[];
  sources: {
    id: string;
    orgSlug: string;
    slug: string;
    latestDate: string | null;
    hasChangelog?: boolean;
    hasHighlights?: boolean;
  }[];
  products: { orgSlug: string; slug: string }[];
  collections: { slug: string; updatedAt: string }[];
};

async function callSitemap(): Promise<SitemapResponse> {
  const res = await app.fetch(new Request("http://test/sitemap"), { DB: testDatabase.db });
  expect(res.status).toBe(200);
  return (await res.json()) as SitemapResponse;
}

beforeAll(() => {
  testDatabase = createTestDb();
  app = new Hono();
  app.route("/", sitemapRoutes);
});

afterAll(() => {
  testDatabase.cleanup();
});

beforeEach(() => {
  clearAllTables(testDatabase.db);
});

describe("GET /sitemap", () => {
  test("returns empty payload when DB has no orgs", async () => {
    const result = await callSitemap();
    // Empty-org responses still include `collections` (this DB also has none).
    expect(result).toEqual({ orgs: [], sources: [], products: [], collections: [] });
  });

  test("emits collection slugs sorted, with updatedAt for lastmod", async () => {
    const db = testDatabase.db;
    db.insert(collections)
      .values([
        {
          id: "col_b",
          slug: "b-collection",
          name: "B",
          updatedAt: "2026-04-01T00:00:00Z",
          createdAt: "2026-03-01T00:00:00Z",
        },
        {
          id: "col_a",
          slug: "a-collection",
          name: "A",
          updatedAt: "2026-04-15T00:00:00Z",
          createdAt: "2026-03-01T00:00:00Z",
        },
      ])
      .run();

    // Membership shouldn't matter for sitemap inclusion — empty collections
    // are still real URLs that should be discoverable.
    const result = await callSitemap();
    expect(result.collections).toEqual([
      { slug: "a-collection", updatedAt: "2026-04-15T00:00:00Z" },
      { slug: "b-collection", updatedAt: "2026-04-01T00:00:00Z" },
    ]);
  });

  test("emits an org entry with null lastActivity when it has no sources", async () => {
    const db = testDatabase.db;
    db.insert(organizations).values({ name: "Solo", slug: "solo" }).run();

    const result = await callSitemap();
    expect(result.orgs).toEqual([{ slug: "solo", lastActivity: null }]);
    expect(result.sources).toEqual([]);
    expect(result.products).toEqual([]);
  });

  test("groups sources under their org slug, carries latest release date", async () => {
    const db = testDatabase.db;
    const [org] = db.insert(organizations).values({ name: "Acme", slug: "acme" }).returning().all();
    const [src] = db
      .insert(sources)
      .values({
        orgId: org.id,
        name: "Acme CLI",
        slug: "acme-cli",
        type: "github",
        url: "https://github.com/acme/cli",
      })
      .returning()
      .all();
    db.insert(releases)
      .values([
        {
          sourceId: src.id,
          url: "https://example.com/r1",
          title: "v1",
          content: "",
          publishedAt: "2026-01-02T00:00:00Z",
        },
        {
          sourceId: src.id,
          url: "https://example.com/r2",
          title: "v2",
          content: "",
          publishedAt: "2026-03-15T00:00:00Z",
        },
        {
          sourceId: src.id,
          url: "https://example.com/r3",
          title: "no date",
          content: "",
          publishedAt: null,
        },
      ])
      .run();

    const result = await callSitemap();

    expect(result.orgs).toEqual([{ slug: "acme", lastActivity: null }]);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      orgSlug: "acme",
      slug: "acme-cli",
      latestDate: "2026-03-15T00:00:00Z",
      hasChangelog: false,
      hasHighlights: false,
    });
    expect(result.sources[0].id).toBe(src.id);
  });

  test("filters out hidden sources but keeps their parent org", async () => {
    const db = testDatabase.db;
    const [org] = db.insert(organizations).values({ name: "Corp", slug: "corp" }).returning().all();
    db.insert(sources)
      .values([
        {
          orgId: org.id,
          name: "Visible",
          slug: "corp-visible",
          type: "feed",
          url: "https://corp.com/v",
        },
        {
          orgId: org.id,
          name: "Hidden",
          slug: "corp-hidden",
          type: "feed",
          url: "https://corp.com/h",
          isHidden: true,
        },
      ])
      .run();

    const result = await callSitemap();

    expect(result.orgs.map((o) => o.slug)).toEqual(["corp"]);
    expect(result.sources.map((s) => s.slug)).toEqual(["corp-visible"]);
  });

  test("excludes on_demand orgs from the sitemap", async () => {
    const db = testDatabase.db;
    db.insert(organizations)
      .values([
        { name: "Curated Org", slug: "curated-org", discovery: "curated" },
        { name: "On Demand Org", slug: "on-demand-org", discovery: "on_demand", isHidden: true },
      ])
      .run();

    const result = await callSitemap();

    // Only the curated org should appear — on_demand orgs are excluded by
    // the organizations_public view (#1603).
    expect(result.orgs.map((o) => o.slug)).toEqual(["curated-org"]);
  });

  test("emits one product entry per org/product, grouped by org slug", async () => {
    const db = testDatabase.db;
    const [o1] = db
      .insert(organizations)
      .values({ name: "Vercel", slug: "vercel" })
      .returning()
      .all();
    const [o2] = db
      .insert(organizations)
      .values({ name: "Other", slug: "other" })
      .returning()
      .all();
    db.insert(products)
      .values([
        { orgId: o1.id, name: "Next.js", slug: "nextjs" },
        { orgId: o1.id, name: "Turborepo", slug: "turborepo" },
        { orgId: o2.id, name: "Thing", slug: "thing" },
      ])
      .run();

    const result = await callSitemap();

    const pairs = result.products.map((p) => `${p.orgSlug}/${p.slug}`).toSorted();
    expect(pairs).toEqual(["other/thing", "vercel/nextjs", "vercel/turborepo"]);
  });

  test("carries lastActivity from the max(sources.lastFetchedAt) for each org", async () => {
    const db = testDatabase.db;
    const [org] = db.insert(organizations).values({ name: "Org", slug: "org" }).returning().all();
    db.insert(sources)
      .values([
        {
          orgId: org.id,
          name: "A",
          slug: "org-a",
          type: "feed",
          url: "https://a.org/",
          lastFetchedAt: "2026-04-10T00:00:00Z",
        },
        {
          orgId: org.id,
          name: "B",
          slug: "org-b",
          type: "feed",
          url: "https://b.org/",
          lastFetchedAt: "2026-04-15T09:00:00Z",
        },
      ])
      .run();

    const result = await callSitemap();
    expect(result.orgs).toEqual([{ slug: "org", lastActivity: "2026-04-15T09:00:00Z" }]);
  });
});
