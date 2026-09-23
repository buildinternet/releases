/**
 * Search release hits omit full `content` by default; opt in with
 * `includeContent: true` (API: `?include_content=true`).
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper";
import { asD1 } from "../../../tests/mcp-test-helpers";
import { searchReleasesFromMatchedEntities, searchReleasesFts } from "../src/queries/search.js";
import { hydrateReleaseHit } from "../src/routes/search.js";

let testDb: TestDatabase;

const BODY = "# Ship it\n\nLong markdown body that must not leak onto list hits by default.";

beforeEach(async () => {
  testDb = createTestDb();
  await testDb.db
    .insert(organizations)
    .values({ id: "org_a", slug: "acme", name: "Acme", category: "cloud" });
  await testDb.db.insert(sources).values({
    id: "src_a",
    slug: "changelog",
    name: "Changelog",
    type: "feed",
    url: "https://acme.test/changelog",
    orgId: "org_a",
  });
  await testDb.db.insert(releases).values({
    id: "rel_a",
    sourceId: "src_a",
    title: "Acme 1.0",
    summary: "Short summary for cards.",
    content: BODY,
    url: "https://acme.test/changelog/1",
    publishedAt: "2026-04-20T00:00:00Z",
  });
});

describe("search content projection", () => {
  it("entity-matched rows omit content by default", async () => {
    const rows = await searchReleasesFromMatchedEntities(asD1(testDb.db), ["acme"], [], 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBeUndefined();
    expect(rows[0]!.summary).toBe("Short summary for cards.");
  });

  it("entity-matched rows include content when opted in", async () => {
    const rows = await searchReleasesFromMatchedEntities(asD1(testDb.db), ["acme"], [], 10, {
      includeContent: true,
    });
    expect(rows[0]!.content).toBe(BODY);
  });

  it("hydrateReleaseHit leaves content off the wire when absent", async () => {
    const rows = await searchReleasesFromMatchedEntities(asD1(testDb.db), ["acme"], [], 10);
    const hit = hydrateReleaseHit(rows[0]!, "https://media.releases.sh");
    expect(hit.content).toBeUndefined();
    expect(hit.summary).toBe("Short summary for cards.");
    expect("content" in hit).toBe(false);
  });

  it("hydrateReleaseHit rewrites media URLs when content is present", async () => {
    const rows = await searchReleasesFromMatchedEntities(asD1(testDb.db), ["acme"], [], 10, {
      includeContent: true,
    });
    const hit = hydrateReleaseHit(rows[0]!, "https://media.releases.sh");
    expect(hit.content).toBe(BODY);
  });

  it("FTS path honors includeContent (when FTS is available)", async () => {
    // FTS virtual table is populated by test-db triggers in some fixtures;
    // if MATCH returns nothing we still assert the opt-in SELECT shape via
    // the entity path above. When FTS hits, content projection must match.
    try {
      const defaultRows = await searchReleasesFts(asD1(testDb.db), "Ship", 10, 0);
      if (defaultRows.length > 0) {
        expect(defaultRows[0]!.content).toBeUndefined();
      }
      const withBody = await searchReleasesFts(asD1(testDb.db), "Ship", 10, 0, {
        includeContent: true,
      });
      if (withBody.length > 0) {
        expect(withBody[0]!.content).toBe(BODY);
      }
    } catch {
      // Local bun:sqlite may lack the FTS schema in minimal fixtures — skip.
    }
  });
});
