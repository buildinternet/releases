/**
 * Tests for resolveReleaseIdsByUrl — the citation source-URL → release_id
 * resolver used by upsertOrgOverview.
 *
 * Coverage:
 * 1. Exact case-insensitive match
 * 2. Empty input
 * 3. Citation has fragment, release stored with bare URL → fallback resolves
 * 4. Citation has fragment, release has matching fragment → exact match wins
 * 5. Citation has fragment, release has different fragment → still null
 *    (intentional: see overview-upsert.ts header comment, #1003)
 * 6. Mixed batch — exact + fallback in one call
 * 7. Duplicate input URLs are de-duplicated
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { createTestDb, clearAllTables, type TestDatabase } from "../../../tests/db-helper.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { resolveReleaseIdsByUrl } from "./overview-upsert.js";

// Cast bun-sqlite TestDb to the DrizzleD1Database shape our helpers accept.
const asDb = (db: TestDatabase["db"]): any => db as any;

function seedOrg(tdb: TestDatabase) {
  tdb.db
    .insert(organizations)
    .values({
      id: "org_cit_01",
      name: "Citation Test Org",
      slug: "citation-test",
      discovery: "curated" as const,
    })
    .run();
}

function seedSource(tdb: TestDatabase, overrides: Partial<typeof sources.$inferInsert> = {}) {
  tdb.db
    .insert(sources)
    .values({
      id: "src_cit_01",
      name: "Citation Source",
      slug: "citation-source",
      type: "scrape" as const,
      url: "https://example.com/changelog",
      orgId: "org_cit_01",
      discovery: "curated" as const,
      ...overrides,
    })
    .run();
}

function seedRelease(tdb: TestDatabase, overrides: Partial<typeof releases.$inferInsert> = {}) {
  tdb.db
    .insert(releases)
    .values({
      id: "rel_cit_01",
      sourceId: "src_cit_01",
      title: "Test Release",
      content: "body",
      publishedAt: "2026-05-01T00:00:00Z",
      fetchedAt: "2026-05-01T01:00:00Z",
      ...overrides,
    })
    .run();
}

describe("resolveReleaseIdsByUrl", () => {
  let tdb: TestDatabase;

  beforeAll(() => {
    tdb = createTestDb();
  });

  beforeEach(() => {
    clearAllTables(tdb.db);
    seedOrg(tdb);
    seedSource(tdb);
  });

  afterAll(() => {
    tdb.cleanup();
  });

  it("returns an empty map for an empty input", async () => {
    const out = await resolveReleaseIdsByUrl(asDb(tdb.db), []);
    expect(out.size).toBe(0);
  });

  it("resolves an exact case-insensitive URL match", async () => {
    seedRelease(tdb, {
      id: "rel_exact",
      url: "https://example.com/changelog/v1.0",
    });

    const out = await resolveReleaseIdsByUrl(asDb(tdb.db), ["HTTPS://example.com/CHANGELOG/v1.0"]);
    expect(out.get("https://example.com/changelog/v1.0")).toBe("rel_exact");
  });

  it("falls back to fragment-stripped match when citation has a fragment", async () => {
    // Per-release-page source: release stored with bare URL, citation
    // gratuitously carries a `#anchor`. Exact match misses; strip-fallback
    // resolves to the same release.
    seedRelease(tdb, {
      id: "rel_bare",
      url: "https://example.com/changelog/v2.0",
    });

    const out = await resolveReleaseIdsByUrl(asDb(tdb.db), [
      "https://example.com/changelog/v2.0#highlights",
    ]);
    expect(out.get("https://example.com/changelog/v2.0#highlights")).toBe("rel_bare");
  });

  it("prefers exact match over fragment-stripped fallback", async () => {
    // Two releases share a base URL but differ by fragment. The citation's
    // exact-match release wins over the fallback path, even if another
    // release happens to live at the same base URL with no fragment.
    seedRelease(tdb, {
      id: "rel_with_fragment",
      url: "https://example.com/changelog#v1.0",
    });
    seedRelease(tdb, {
      id: "rel_bare_match",
      sourceId: "src_cit_01",
      url: "https://example.com/changelog",
    });

    const out = await resolveReleaseIdsByUrl(asDb(tdb.db), ["https://example.com/changelog#v1.0"]);
    expect(out.get("https://example.com/changelog#v1.0")).toBe("rel_with_fragment");
  });

  it("returns no entry when fragments mismatch and no bare URL exists", async () => {
    // CHANGELOG-anchored source: every release shares a base URL with its
    // own fragment. A citation fragment that doesn't match any stored
    // release fragment still returns null — we intentionally do not fuzzy-
    // match against titles (see overview-upsert.ts header, #1003).
    seedRelease(tdb, {
      id: "rel_v1",
      url: "https://example.com/changelog#section-a",
    });
    seedRelease(tdb, {
      id: "rel_v2",
      sourceId: "src_cit_01",
      url: "https://example.com/changelog#section-b",
    });

    const out = await resolveReleaseIdsByUrl(asDb(tdb.db), [
      "https://example.com/changelog#section-c-the-one-that-doesnt-exist",
    ]);
    expect(
      out.get("https://example.com/changelog#section-c-the-one-that-doesnt-exist"),
    ).toBeUndefined();
  });

  it("handles a mixed batch (exact + fallback in one call)", async () => {
    seedRelease(tdb, {
      id: "rel_exact_a",
      url: "https://example.com/changelog#feature-a",
    });
    seedRelease(tdb, {
      id: "rel_fallback_b",
      sourceId: "src_cit_01",
      url: "https://example.com/changelog/v3.0",
    });

    const out = await resolveReleaseIdsByUrl(asDb(tdb.db), [
      "https://example.com/changelog#feature-a", // exact
      "https://example.com/changelog/v3.0#anything", // fallback
    ]);
    expect(out.get("https://example.com/changelog#feature-a")).toBe("rel_exact_a");
    expect(out.get("https://example.com/changelog/v3.0#anything")).toBe("rel_fallback_b");
  });

  it("deduplicates input URLs that differ only in case", async () => {
    seedRelease(tdb, {
      id: "rel_dedup",
      url: "https://example.com/changelog/dedup",
    });

    const out = await resolveReleaseIdsByUrl(asDb(tdb.db), [
      "https://example.com/changelog/dedup",
      "HTTPS://EXAMPLE.COM/CHANGELOG/DEDUP",
    ]);
    expect(out.size).toBe(1);
    expect(out.get("https://example.com/changelog/dedup")).toBe("rel_dedup");
  });
});
