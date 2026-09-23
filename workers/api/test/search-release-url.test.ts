/**
 * `url` on release search hits (#2330). Search results and the lookup rail
 * link releases upstream via `releaseLinkProps()`, which needs the release's
 * source `url` on the wire — this covers the lexical/entity-matched query
 * path (`searchReleasesFromMatchedEntities`) and `hydrateReleaseHit`'s
 * projection onto the wire shape.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper";
import { asD1 } from "../../../tests/mcp-test-helpers";
import { searchReleasesFromMatchedEntities } from "../src/queries/search.js";
import { hydrateReleaseHit } from "../src/routes/search.js";

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = createTestDb();
  await testDb.db
    .insert(organizations)
    .values({ id: "org_a", slug: "acme", name: "Acme", category: "cloud" });
  await testDb.db.insert(sources).values({
    id: "src_x",
    slug: "x-feed",
    name: "X Feed",
    type: "feed",
    url: "https://acme.test/x",
    orgId: "org_a",
  });
  await testDb.db.insert(releases).values([
    {
      id: "rel_x",
      sourceId: "src_x",
      title: "X 1.0",
      content: "x",
      url: "https://acme.test/x/1",
      publishedAt: "2026-04-20T00:00:00Z",
    },
    {
      id: "rel_no_url",
      sourceId: "src_x",
      title: "X 0.9",
      content: "x",
      url: null,
      publishedAt: "2026-04-19T00:00:00Z",
    },
  ]);
});

describe("release-hit url", () => {
  it("selects the release's upstream url", async () => {
    const rows = await searchReleasesFromMatchedEntities(asD1(testDb.db), ["acme"], [], 50);
    expect(rows.find((r) => r.id === "rel_x")?.url).toBe("https://acme.test/x/1");
  });

  it("leaves url null for a release with none", async () => {
    const rows = await searchReleasesFromMatchedEntities(asD1(testDb.db), ["acme"], [], 50);
    expect(rows.find((r) => r.id === "rel_no_url")?.url ?? null).toBeNull();
  });

  it("hydrateReleaseHit forwards url to the wire shape", async () => {
    const rows = await searchReleasesFromMatchedEntities(asD1(testDb.db), ["acme"], [], 50);
    const withUrl = hydrateReleaseHit(
      rows.find((r) => r.id === "rel_x")!,
      "https://media.releases.sh",
    );
    const withoutUrl = hydrateReleaseHit(
      rows.find((r) => r.id === "rel_no_url")!,
      "https://media.releases.sh",
    );
    expect(withUrl.url).toBe("https://acme.test/x/1");
    expect(withoutUrl.url ?? null).toBeNull();
  });
});
