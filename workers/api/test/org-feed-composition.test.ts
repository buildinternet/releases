import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, makeD1Shim } from "../../../tests/db-helper";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { parseCompositionFromMetadata } from "@buildinternet/releases-core/composition";
import { getOrgReleasesFeed } from "../src/queries/orgs.js";
import { formatAggregateReleaseRow } from "../src/utils.js";
import type { AggregateReleaseRow } from "@releases/core-internal/feed-cursor";

const noCursor = { cursorWhere: "", cursorBindings: [] };

describe("release feed composition", () => {
  describe("getOrgReleasesFeed (org / product feed)", () => {
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
        .values({ id: "org_a", slug: "codex", name: "Codex", category: "ai" });
      await db.insert(sources).values({
        id: "src_a",
        slug: "codex-changelog",
        name: "Codex Changelog",
        type: "scrape",
        url: "https://example.com/changelog",
        orgId: "org_a",
      });
      await db.insert(releases).values({
        id: "rel_a",
        sourceId: "src_a",
        title: "Appshots launch; goal mode exits beta",
        version: "1.4",
        content: "Notes.",
        publishedAt: "2026-05-21T00:00:00Z",
        metadata: JSON.stringify({ composition: { bugs: 1, features: 6, enhancements: 1 } }),
      });
    });

    it("selects releases.metadata so the route can parse composition", async () => {
      const rows = await getOrgReleasesFeed(d1, "org_a", noCursor, 50);
      expect(rows).toHaveLength(1);
      expect(parseCompositionFromMetadata(rows[0].metadata)).toEqual({
        bugs: 1,
        features: 6,
        enhancements: 1,
      });
    });
  });

  describe("formatAggregateReleaseRow (collection / category feed)", () => {
    const baseRow: AggregateReleaseRow = {
      id: "rel_b",
      version: "2.4.0",
      title: "Performance and stability improvements",
      content: "Notes.",
      summary: "Notes.",
      title_generated: null,
      title_short: null,
      published_at: "2026-05-14T00:00:00Z",
      fetched_at: "2026-05-14T01:00:00Z",
      url: null,
      media: null,
      prerelease: 0,
      source_slug: "codex-changelog",
      source_name: "Codex Changelog",
      source_type: "scrape",
      type: "feature",
      org_slug: "codex",
      org_name: "Codex",
      product_slug: null,
      product_name: null,
      coverage_count: 0,
    };

    it("parses composition from the row's metadata", () => {
      const item = formatAggregateReleaseRow(
        {
          ...baseRow,
          metadata: JSON.stringify({ composition: { bugs: 12, features: 3, enhancements: 2 } }),
        },
        "",
      );
      expect(item.composition).toEqual({ bugs: 12, features: 3, enhancements: 2 });
    });

    it("leaves composition null when metadata is absent or has no counts", () => {
      expect(formatAggregateReleaseRow(baseRow, "").composition).toBeNull();
      expect(
        formatAggregateReleaseRow({ ...baseRow, metadata: "not json" }, "").composition,
      ).toBeNull();
    });
  });
});
