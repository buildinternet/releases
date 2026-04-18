/**
 * Read-path collapse: releases listed in `release_coverage` as the coverage
 * side are hidden by default from latest / list / search. The canonical row
 * stays visible. `--include-coverage` (CLI) / `?include_coverage=true` (API) /
 * `include_coverage: true` (MCP) flips the filter off.
 *
 * Exercises `getLatestReleases` against a seeded test DB — same mock.module
 * trick as tests/unit/sitemap.test.ts so the singleton `getDb()` uses our
 * isolated SQLite file.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { sql } from "drizzle-orm";
import { createTestDb, clearAllTables, type TestDatabase } from "../db-helper.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";

let testDatabase: TestDatabase;

beforeAll(() => {
  testDatabase = createTestDb();
  mock.module("../../src/db/connection.js", () => ({
    getDb: () => testDatabase.db,
  }));
  mock.module("../../src/lib/mode.js", () => ({
    isRemoteMode: () => false,
    isAdminMode: () => false,
    getApiUrl: () => "",
    getApiKey: () => "",
  }));
});

afterAll(() => {
  testDatabase.cleanup();
});

beforeEach(() => {
  clearAllTables(testDatabase.db);
  // Coverage rows FK-cascade when the releases are cleared, so this is a no-op
  // after `clearAllTables`, but kept explicit for future-readers.
  testDatabase.db.run(sql`DELETE FROM release_coverage`);
});

async function seedCluster() {
  const db = testDatabase.db;

  db.insert(organizations)
    .values({ id: "org_test", name: "Test Org", slug: "test-org" })
    .run();
  db.insert(sources)
    .values({
      id: "src_test",
      orgId: "org_test",
      slug: "test-src",
      name: "Test Source",
      type: "feed",
      url: "https://example.com/changelog",
    })
    .run();

  // Canonical release (the "real" launch) + a coverage release (a blog post
  // that re-announces the same thing).
  db.insert(releases)
    .values([
      {
        id: "rel_canon",
        sourceId: "src_test",
        title: "Platform 5.0",
        content: "Big launch",
        contentHash: "h1",
        publishedAt: "2026-04-15T00:00:00.000Z",
      },
      {
        id: "rel_blog",
        sourceId: "src_test",
        title: "Announcing Platform 5.0 on our blog",
        content: "Marketing post",
        contentHash: "h2",
        publishedAt: "2026-04-16T00:00:00.000Z",
      },
    ])
    .run();

  db.run(sql`
    INSERT INTO release_coverage (coverage_id, canonical_id, reason, decided_by, decided_at)
    VALUES ('rel_blog', 'rel_canon', 'marketing restatement', 'human:cli', '2026-04-17T00:00:00.000Z')
  `);
}

describe("getLatestReleases — coverage collapse", () => {
  it("hides coverage rows by default, keeping only the canonical release visible", async () => {
    await seedCluster();

    const { getLatestReleases } = await import("../../src/db/queries.js");
    const rows = await getLatestReleases({ count: 50 });

    const ids = rows.map((r) => r.id);
    expect(ids).toContain("rel_canon");
    expect(ids).not.toContain("rel_blog");
  });

  it("returns both releases when includeCoverage is true", async () => {
    await seedCluster();

    const { getLatestReleases } = await import("../../src/db/queries.js");
    const rows = await getLatestReleases({ count: 50, includeCoverage: true });

    const ids = rows.map((r) => r.id);
    expect(ids).toContain("rel_canon");
    expect(ids).toContain("rel_blog");
  });

  it("still collapses when scoped to a source — the coverage row lives under that source too", async () => {
    await seedCluster();

    const { getLatestReleases } = await import("../../src/db/queries.js");
    const scoped = await getLatestReleases({ slug: "test-src", count: 50 });
    expect(scoped.map((r) => r.id)).toEqual(["rel_canon"]);

    const withCoverage = await getLatestReleases({ slug: "test-src", count: 50, includeCoverage: true });
    expect(withCoverage.map((r) => r.id).sort()).toEqual(["rel_blog", "rel_canon"]);
  });
});
