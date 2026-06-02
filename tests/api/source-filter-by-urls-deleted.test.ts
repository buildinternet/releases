/**
 * Regression coverage for #1184 (create-revives half): the `filterByUrls`
 * dedup pre-check — used by the CLI's `source create` / `import` before
 * inserting — must NOT surface soft-deleted (tombstoned) sources. Returning a
 * tombstone here makes create "revive" the deleted row (reporting the mangled
 * `<slug>--<id>` slug as `existed: true`) instead of starting fresh.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { sourceRoutes } from "../../workers/api/src/routes/sources.js";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { makeCaller } from "./route-test-helpers.js";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

const callSource = makeCaller(sourceRoutes, () => ({ DB: testDb.db as unknown as never }));

const DUP_URL = "https://acme.com/changelog";

async function seedOrg() {
  await testDb.db.insert(organizations).values({
    id: "org_acme",
    name: "Acme",
    slug: "acme",
    discovery: "curated",
  });
}

describe("GET /v1/sources?filterByUrls — excludes soft-deleted sources (#1184)", () => {
  it("returns an active source matching the URL", async () => {
    await seedOrg();
    await testDb.db.insert(sources).values({
      id: "src_live",
      name: "Acme Changelog",
      slug: "acme-changelog",
      orgId: "org_acme",
      type: "scrape",
      url: DUP_URL,
      metadata: "{}",
    });

    const res = await callSource(`/sources?filterByUrls=true&url=${encodeURIComponent(DUP_URL)}`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["src_live"]);
  });

  it("omits a tombstoned source matching the URL", async () => {
    await seedOrg();
    // Mirror the soft-delete handler: deletedAt set + slug mangled to <slug>--<id>.
    await testDb.db.insert(sources).values({
      id: "src_dead",
      name: "Acme Changelog",
      slug: "acme-changelog--src_dead",
      orgId: "org_acme",
      type: "scrape",
      url: DUP_URL,
      metadata: "{}",
      deletedAt: new Date().toISOString(),
    });

    const res = await callSource(`/sources?filterByUrls=true&url=${encodeURIComponent(DUP_URL)}`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ id: string }>;
    expect(rows).toEqual([]);
  });

  it("returns only the live row when a live + tombstoned source share a URL", async () => {
    await seedOrg();
    await testDb.db.insert(sources).values([
      {
        id: "src_dead2",
        name: "Acme Changelog (old)",
        slug: "acme-changelog--src_dead2",
        orgId: "org_acme",
        type: "scrape",
        url: DUP_URL,
        metadata: "{}",
        deletedAt: new Date().toISOString(),
      },
      {
        id: "src_live2",
        name: "Acme Changelog",
        slug: "acme-changelog",
        orgId: "org_acme",
        type: "scrape",
        url: DUP_URL,
        metadata: "{}",
      },
    ]);

    const res = await callSource(`/sources?filterByUrls=true&url=${encodeURIComponent(DUP_URL)}`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["src_live2"]);
  });
});
