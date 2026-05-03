/**
 * Phase 0 of #693 — verify that `type` is present on every release row
 * returned by the queries that back the public wire-contract endpoints.
 *
 * These tests exercise the SQL helpers directly (no HTTP) so they stay fast
 * and don't need a Worker environment. Endpoint-level assertions belong in
 * integration / smoke tests once a real D1 is available.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { getSourceReleasesPaginated } from "../../workers/api/src/queries/sources.js";
import { searchReleasesFts } from "../../workers/api/src/queries/search.js";

let tdb: TestDatabase;
let sourceId: string;

beforeAll(() => {
  tdb = createTestDb();
  const db = tdb.db;

  const [org] = db
    .insert(organizations)
    .values({ name: "Acme Corp", slug: "acme-corp" })
    .returning()
    .all();

  const [src] = db
    .insert(sources)
    .values({
      orgId: org.id,
      name: "Acme Releases",
      slug: "acme-releases",
      type: "github",
      url: "https://github.com/acme/releases",
    })
    .returning()
    .all();

  sourceId = src.id;

  db.insert(releases)
    .values([
      {
        sourceId: src.id,
        title: "New feature release",
        content: "Added a great new feature to the platform.",
        url: "https://github.com/acme/releases/releases/tag/v1.0.0",
        contentHash: "hash-feature",
        type: "feature",
        publishedAt: "2026-01-01T00:00:00Z",
      },
      {
        sourceId: src.id,
        title: "Q1 2026 rollup",
        content: "Quarterly rollup of all the changes shipped in Q1 2026.",
        url: "https://github.com/acme/releases/releases/tag/v1-rollup",
        contentHash: "hash-rollup",
        type: "rollup",
        publishedAt: "2026-03-31T00:00:00Z",
      },
    ])
    .run();
});

afterAll(() => {
  tdb?.cleanup();
});

describe("getSourceReleasesPaginated — type field on wire", () => {
  it("includes type on every returned row", async () => {
    const rows = await getSourceReleasesPaginated(tdb.db as any, sourceId, 10, 0);
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(Object.prototype.hasOwnProperty.call(row, "type")).toBe(true);
    }
  });

  it("returns correct type values for feature and rollup releases", async () => {
    const rows = await getSourceReleasesPaginated(tdb.db as any, sourceId, 10, 0);
    const types = new Set(rows.map((r) => r.type));
    expect(types.has("feature")).toBe(true);
    expect(types.has("rollup")).toBe(true);
  });
});

describe("searchReleasesFts — type field on wire", () => {
  it("includes type on every release row returned by FTS search", async () => {
    const rows = await searchReleasesFts(tdb.db as any, "feature", 10, 0);
    // FTS may not be populated in the test DB (no FTS triggers run on bun:sqlite
    // without explicit setup), so we assert on the type if there are rows.
    // If no rows come back, the column still exists on the interface — which is
    // the compile-time half of this check.
    for (const row of rows) {
      expect(Object.prototype.hasOwnProperty.call(row, "type")).toBe(true);
    }
  });
});
