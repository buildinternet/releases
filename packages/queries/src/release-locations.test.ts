import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { organizations, releaseLocations } from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { listReleaseLocationRows, loadReleaseLocations } from "./release-locations.js";

const NOW = "2026-07-05T00:00:00.000Z";

function loc(id: string, url: string, extra: Partial<typeof releaseLocations.$inferInsert> = {}) {
  return {
    id,
    orgId: "org_s",
    url,
    canonical: false,
    basis: "declared" as const,
    matchKey: `url:${url}`,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

describe("release location reads", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = createTestDb();
    await tdb.db
      .insert(organizations)
      .values({ id: "org_s", name: "Stubby", slug: "stubby", tier: "stub" });
    await tdb.db
      .insert(releaseLocations)
      .values([
        loc("loc_a", "https://a.example.com"),
        loc("loc_z", "https://z.example.com", { canonical: true, title: "Main" }),
        loc("loc_m", "https://m.example.com"),
        loc("loc_gone", "https://gone.example.com", { deletedAt: NOW }),
      ]);
  });

  afterAll(() => tdb.cleanup());

  it("orders canonical first, then by match_key, and drops soft-deleted rows", async () => {
    const rows = await listReleaseLocationRows(tdb.db, "org_s");
    expect(rows.map((r) => r.id)).toEqual(["loc_z", "loc_a", "loc_m"]);
  });

  it("maps rows to wire items with only the set locator keys", async () => {
    const [first] = await loadReleaseLocations(tdb.db, "org_s");
    expect(first).toEqual({
      url: "https://z.example.com",
      title: "Main",
      canonical: true,
      basis: "declared",
      productId: null,
      sourceId: null,
    });
  });
});
