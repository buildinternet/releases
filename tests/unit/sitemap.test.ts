/**
 * Tests for the bulk sitemap endpoint.
 *
 * `handleSitemap` (`src/api/routes/orgs.ts`) and the worker route
 * (`workers/api/src/routes/sitemap.ts`) share the same query logic —
 * three bulk queries keyed by the set of org IDs, grouped client-side.
 * Testing the local handler validates the shape and filtering rules;
 * the worker route is a 1:1 translation that runs the same SQL via D1.
 */

import { describe, test, expect, beforeEach, afterAll, beforeAll, mock } from "bun:test";
import { createTestDb, clearAllTables, type TestDatabase } from "../db-helper.js";
import { organizations, sources, products, releases } from "@buildinternet/releases-core/schema";

let testDatabase: TestDatabase;

beforeAll(() => {
  testDatabase = createTestDb();
  // Swap the singleton so handleSitemap (which calls getDb()) uses our test DB.
  mock.module("../../src/db/connection.js", () => ({
    getDb: () => testDatabase.db,
  }));
});

afterAll(() => {
  testDatabase.cleanup();
});

beforeEach(() => {
  clearAllTables(testDatabase.db);
});

// Dynamic import so the mock.module above applies before the handler binds to getDb().
async function callSitemap() {
  const mod = await import("../../src/api/routes/orgs.js");
  return mod.handleSitemap();
}

describe("handleSitemap", () => {
  test("returns empty payload when DB has no orgs", async () => {
    const result = await callSitemap();
    expect(result).toEqual({ orgs: [], sources: [], products: [] });
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
    db.insert(releases).values([
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
    ]).run();

    const result = await callSitemap();

    expect(result.orgs).toEqual([{ slug: "acme", lastActivity: null }]);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toEqual({
      orgSlug: "acme",
      slug: "acme-cli",
      latestDate: "2026-03-15T00:00:00Z",
    });
  });

  test("filters out hidden sources but keeps their parent org", async () => {
    const db = testDatabase.db;
    const [org] = db.insert(organizations).values({ name: "Corp", slug: "corp" }).returning().all();
    db.insert(sources).values([
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
    ]).run();

    const result = await callSitemap();

    expect(result.orgs.map((o) => o.slug)).toEqual(["corp"]);
    expect(result.sources.map((s) => s.slug)).toEqual(["corp-visible"]);
  });

  test("emits one product entry per org/product, grouped by org slug", async () => {
    const db = testDatabase.db;
    const [o1] = db.insert(organizations).values({ name: "Vercel", slug: "vercel" }).returning().all();
    const [o2] = db.insert(organizations).values({ name: "Other", slug: "other" }).returning().all();
    db.insert(products).values([
      { orgId: o1.id, name: "Next.js", slug: "nextjs" },
      { orgId: o1.id, name: "Turborepo", slug: "turborepo" },
      { orgId: o2.id, name: "Thing", slug: "thing" },
    ]).run();

    const result = await callSitemap();

    const pairs = result.products.map((p) => `${p.orgSlug}/${p.slug}`).sort();
    expect(pairs).toEqual(["other/thing", "vercel/nextjs", "vercel/turborepo"]);
  });

  test("excludes orphan sources (orgId is null)", async () => {
    const db = testDatabase.db;
    db.insert(organizations).values({ name: "Host", slug: "host" }).run();
    db.insert(sources).values({
      orgId: null,
      name: "Orphan",
      slug: "orphan",
      type: "feed",
      url: "https://orphan.dev/",
    }).run();

    const result = await callSitemap();
    expect(result.sources).toEqual([]);
    expect(result.orgs.map((o) => o.slug)).toEqual(["host"]);
  });

  test("carries lastActivity from the max(sources.lastFetchedAt) for each org", async () => {
    const db = testDatabase.db;
    const [org] = db.insert(organizations).values({ name: "Org", slug: "org" }).returning().all();
    db.insert(sources).values([
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
    ]).run();

    const result = await callSitemap();
    expect(result.orgs).toEqual([
      { slug: "org", lastActivity: "2026-04-15T09:00:00Z" },
    ]);
  });
});
