import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { sourceRoutes } from "../src/routes/sources.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";

/**
 * PATCH /v1/releases/:id { url } hits UNIQUE(source_id, url)
 * (idx_releases_source_url). The route must answer 409 and name the release
 * that already stores that URL, instead of a 500 from the failed UPDATE.
 */
let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

describe("PATCH /v1/releases/:id url conflict", () => {
  test("returns 409 naming the release that already stores the url", async () => {
    await testDb.db.insert(organizations).values({ id: "org_acme", name: "Acme", slug: "acme" });
    await testDb.db.insert(sources).values({
      id: "src_1",
      name: "Acme Changelog",
      slug: "acme-changelog",
      orgId: "org_acme",
      type: "scrape",
      url: "https://acme.example/changelog",
    });
    await testDb.db.insert(releases).values([
      {
        id: "rel_existing",
        sourceId: "src_1",
        title: "Existing",
        content: "a",
        url: "https://acme.example/releases/1",
      },
      {
        id: "rel_edit",
        sourceId: "src_1",
        title: "Edit me",
        content: "b",
        url: "https://acme.example/releases/2",
      },
    ]);

    const res = await sourceRoutes.request(
      "/releases/rel_edit",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://acme.example/releases/1" }),
      },
      { DB: testDb.db as unknown as never },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; type: string; message: string; details?: { releaseId?: string } };
    };
    expect(body.error.code).toBe("conflict");
    expect(body.error.type).toBe("conflict");
    expect(body.error.message).toContain("rel_existing");
    expect(body.error.details?.releaseId).toBe("rel_existing");

    const [row] = await testDb.db
      .select({ url: releases.url })
      .from(releases)
      .where(eq(releases.id, "rel_edit"));
    expect(row?.url).toBe("https://acme.example/releases/2");
  });
});
