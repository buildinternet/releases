/**
 * Covers `/v1/fetch-log` reads + writes end-to-end: POST inserts a row,
 * GET surfaces it (both the unscoped list and the source-scoped variant).
 * Tracks the gap called out in #377 (tests/integration/fetch-log.test.ts
 * used to exercise this via the CLI subprocess).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { createTestDb, clearAllTables, type TestDatabase } from "../db-helper.js";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { fetchLogRoutes } from "../../workers/api/src/routes/fetch-log.js";

let testDatabase: TestDatabase;
let fetchApi: (req: Request) => Response | Promise<Response>;

beforeAll(() => {
  testDatabase = createTestDb();
  const app = new Hono();
  app.route("/v1", fetchLogRoutes);
  fetchApi = (req) => app.fetch(req, { DB: testDatabase.db } as never);
});

afterAll(() => {
  testDatabase.cleanup();
});

beforeEach(() => {
  clearAllTables(testDatabase.db);
});

async function seedSource() {
  await testDatabase.db.insert(organizations).values({ id: "org_1", name: "Acme", slug: "acme" });
  await testDatabase.db.insert(sources).values({
    id: "src_1",
    orgId: "org_1",
    name: "Acme",
    slug: "acme-cl",
    type: "feed",
    url: "https://example.com/feed",
  });
}

describe("fetch-log route", () => {
  it("POST inserts a row and GET returns it", async () => {
    await seedSource();

    const postRes = await fetchApi(
      new Request("http://test/v1/fetch-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceId: "src_1",
          status: "success",
          releasesFound: 3,
          releasesInserted: 2,
          durationMs: 120,
        }),
      }),
    );
    expect(postRes.status).toBe(201);
    const inserted = (await postRes.json()) as { id: string; status: string };
    expect(inserted.id).toBeDefined();
    expect(inserted.status).toBe("success");

    const getRes = await fetchApi(new Request("http://test/v1/fetch-log"));
    expect(getRes.status).toBe(200);
    const rows = (await getRes.json()) as Array<{ id: string; sourceId: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceId).toBe("src_1");
  });

  it("GET ?source=<slug> filters to that source", async () => {
    await seedSource();
    await testDatabase.db.insert(sources).values({
      id: "src_2",
      orgId: "org_1",
      name: "Other",
      slug: "other",
      type: "feed",
      url: "https://other.example.com/feed",
    });

    for (const sourceId of ["src_1", "src_2", "src_1"]) {
      await fetchApi(
        new Request("http://test/v1/fetch-log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceId,
            status: "success",
            releasesFound: 0,
            releasesInserted: 0,
          }),
        }),
      );
    }

    const res = await fetchApi(new Request("http://test/v1/fetch-log?source=acme-cl"));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ sourceId: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.sourceId === "src_1")).toBe(true);
  });

  it("GET ?source=<slug> returns 404 for unknown slug", async () => {
    const res = await fetchApi(new Request("http://test/v1/fetch-log?source=nope"));
    expect(res.status).toBe(404);
  });
});
