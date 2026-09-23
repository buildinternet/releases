import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, makeD1Shim } from "../../../tests/db-helper";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { getOrgReleasesFeed } from "../src/queries/orgs.js";

const noCursor = { cursorWhere: "", cursorBindings: [] };

describe("getOrgReleasesFeed appstore metadata", () => {
  let sqlite: Database;
  let db: ReturnType<typeof drizzle>;
  let d1: D1Database;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite);
    applyMigrations(sqlite);
    d1 = makeD1Shim(sqlite);

    await db
      .insert(organizations)
      .values({ id: "org_a", slug: "notion", name: "Notion", category: "cloud" });
    await db.insert(sources).values({
      id: "src_app",
      slug: "notion-ios",
      name: "Notion",
      type: "appstore",
      url: "https://apps.apple.com/us/app/id1232780281",
      orgId: "org_a",
      metadata: JSON.stringify({
        appStore: {
          trackId: "1232780281",
          storefront: "us",
          platform: "ios",
          artworkUrl: "https://is1-ssl.mzstatic.com/a/1024x1024bb.png",
        },
      }),
    });
    await db.insert(releases).values({
      id: "rel_app",
      sourceId: "src_app",
      title: "Notion 3.12.0",
      version: "3.12.0",
      content: "Bug fixes.",
      url: "https://apps.apple.com/us/app/id1232780281?v=3.12.0",
      publishedAt: "2026-05-27T00:00:00Z",
    });
  });

  it("returns source_metadata so the route can derive appStore", async () => {
    const rows = await getOrgReleasesFeed(d1, "org_a", noCursor, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_metadata).toContain('"platform":"ios"');
    expect(rows[0].source_metadata).toContain("1024x1024bb.png");
  });
});
