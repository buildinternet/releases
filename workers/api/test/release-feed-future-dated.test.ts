/**
 * Future-dated guardrail for release feeds. Sources occasionally publish a
 * misdated entry (typo, scheduled-post slip); without this filter the row
 * sticks at the top of the feed until the date arrives. The same guardrail
 * lives in the GraphQL `latestReleases` resolver (covered in graphql.test.ts)
 * and the MCP `get_latest_releases` tool.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, makeD1Shim } from "../../../tests/db-helper";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { getOrgReleasesFeed } from "../src/queries/orgs.js";
import { getSourceReleasesFeed } from "../src/queries/sources.js";

const noCursor = { cursorWhere: "", cursorBindings: [] };

describe("release feeds skip future-dated rows", () => {
  let sqlite: Database;
  let db: ReturnType<typeof drizzle>;
  let d1: D1Database;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite);
    applyMigrations(sqlite);
    d1 = makeD1Shim(sqlite);

    await db.insert(organizations).values({
      id: "org_a",
      slug: "acme",
      name: "Acme",
      category: "cloud",
    });
    await db.insert(sources).values({
      id: "src_a",
      slug: "feed",
      name: "Feed",
      type: "feed",
      url: "https://acme.test/feed",
      orgId: "org_a",
    });

    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    await db.insert(releases).values([
      {
        id: "rel_past",
        sourceId: "src_a",
        title: "past",
        content: "shipped",
        url: "https://acme.test/past",
        publishedAt: "2026-04-20T00:00:00Z",
      },
      {
        id: "rel_future",
        sourceId: "src_a",
        title: "future",
        content: "should be hidden",
        url: "https://acme.test/future",
        publishedAt: future,
      },
    ]);
  });

  it("getOrgReleasesFeed drops releases with publishedAt > now", async () => {
    const rows = await getOrgReleasesFeed(d1, "org_a", noCursor, 50);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("rel_past");
    expect(ids).not.toContain("rel_future");
  });

  it("getSourceReleasesFeed drops releases with publishedAt > now", async () => {
    const rows = await getSourceReleasesFeed(d1, "src_a", noCursor, 50);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("rel_past");
    expect(ids).not.toContain("rel_future");
  });
});
