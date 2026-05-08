/**
 * Release-feed cursor parsing (#806).
 *
 * Two layers of coverage:
 *
 * 1. `parseFeedCursor` — pure parser used by the D1-prepared paths
 *    (`getOrgReleasesFeed`, `getSourceReleasesFeed`). Asserts the SQL
 *    fragment + bindings shape for each cursor wire format.
 *
 * 2. End-to-end against bun-sqlite via `getCollectionReleasesFeed` (which
 *    uses the drizzle mirror `feedCursorSql`). The original bug: when two
 *    releases shared the same `publishedAt`, paginating with the old
 *    two-segment cursor `publishedAt|id` could surface the same row twice
 *    because `id`-DESC tie-break didn't match the ORDER BY's
 *    `fetched_at DESC, id DESC` rule. The new three-segment cursor
 *    `publishedAt|fetchedAt|id` carries the full sort key so ties don't
 *    duplicate.
 */

import { describe, it, expect, beforeEach, afterAll, beforeAll } from "bun:test";
import { buildFeedCursor, parseFeedCursor } from "../../workers/api/src/utils.js";
import { getCollectionReleasesFeed } from "../../workers/api/src/queries/orgs.js";
import type { D1Db } from "../../workers/api/src/db.js";
import { createTestDb, clearAllTables, type TestDatabase } from "../db-helper.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";

const asD1 = (db: TestDatabase["db"]): D1Db => db as unknown as D1Db;

describe("parseFeedCursor", () => {
  it("returns an empty fragment for null/empty cursors", () => {
    expect(parseFeedCursor(null)).toEqual({ cursorWhere: "", cursorBindings: [] });
    expect(parseFeedCursor("")).toEqual({ cursorWhere: "", cursorBindings: [] });
  });

  it("emits a 3-arg lex predicate for the new publishedAt|fetchedAt|id format", () => {
    const result = parseFeedCursor("2026-04-01T00:00:00Z|2026-04-03T00:00:00Z|rel_ccc");
    expect(result.cursorWhere).toBe(
      "AND (r.published_at IS NULL OR " +
        "(r.published_at < ?) OR " +
        "(r.published_at = ? AND r.fetched_at < ?) OR " +
        "(r.published_at = ? AND r.fetched_at = ? AND r.id < ?))",
    );
    expect(result.cursorBindings).toEqual([
      "2026-04-01T00:00:00Z",
      "2026-04-01T00:00:00Z",
      "2026-04-03T00:00:00Z",
      "2026-04-01T00:00:00Z",
      "2026-04-03T00:00:00Z",
      "rel_ccc",
    ]);
  });

  it("accepts the legacy publishedAt|id format (back-compat for in-flight cursors)", () => {
    const result = parseFeedCursor("2026-04-01T00:00:00Z|rel_ccc");
    expect(result.cursorWhere).toBe(
      "AND (r.published_at IS NULL OR " +
        "(r.published_at < ?) OR (r.published_at = ? AND r.id < ?))",
    );
    expect(result.cursorBindings).toEqual([
      "2026-04-01T00:00:00Z",
      "2026-04-01T00:00:00Z",
      "rel_ccc",
    ]);
  });

  it("treats |id as the null-publishedAt segment (legacy 2-part)", () => {
    const result = parseFeedCursor("|rel_xxx");
    expect(result.cursorWhere).toBe("AND (r.published_at IS NULL AND r.id < ?)");
    expect(result.cursorBindings).toEqual(["rel_xxx"]);
  });

  it("emits a null-scoped fetched_at predicate for the null-publishedAt new format", () => {
    const result = parseFeedCursor("|2026-04-03T00:00:00Z|rel_xxx");
    expect(result.cursorWhere).toBe(
      "AND (r.published_at IS NULL AND " +
        "((r.fetched_at < ?) OR (r.fetched_at = ? AND r.id < ?)))",
    );
    expect(result.cursorBindings).toEqual([
      "2026-04-03T00:00:00Z",
      "2026-04-03T00:00:00Z",
      "rel_xxx",
    ]);
  });

  it("falls back to a single-arg predicate for date-only cursors", () => {
    const result = parseFeedCursor("2026-04-01T00:00:00Z");
    expect(result.cursorWhere).toBe("AND (r.published_at IS NULL OR r.published_at < ?)");
    expect(result.cursorBindings).toEqual(["2026-04-01T00:00:00Z"]);
  });
});

describe("release-feed cursor end-to-end (collection feed)", () => {
  let tdb: TestDatabase;

  beforeAll(() => {
    tdb = createTestDb();
  });

  beforeEach(() => {
    clearAllTables(tdb.db);
  });

  afterAll(() => {
    tdb.cleanup();
  });

  /**
   * Three rows with the same `publishedAt` but different `fetchedAt`. With
   * page size 2, the bug would emit `[A, C]` then re-emit A on page 2
   * because the cursor only carried `id`. The fix carries `fetchedAt` too,
   * so page 2 must contain only `B`.
   */
  it("does not duplicate same-publishedAt rows across pages with the new cursor", async () => {
    const db = tdb.db;
    await db
      .insert(organizations)
      .values({ id: "org_1", name: "Org", slug: "org-feed", discovery: "curated" });
    await db.insert(sources).values({
      id: "src_1",
      name: "S",
      slug: "src-1",
      type: "github",
      url: "https://github.com/x/src-1",
      orgId: "org_1",
      discovery: "curated",
    });

    // Sort under `published_at DESC, fetched_at DESC, id DESC`:
    //   A (fetchedAt=2026-04-03, id=rel_aaa) — first
    //   C (fetchedAt=2026-04-02, id=rel_ccc) — second (id-DESC tie-break)
    //   B (fetchedAt=2026-04-02, id=rel_bbb) — third
    await db.insert(releases).values([
      {
        id: "rel_aaa",
        sourceId: "src_1",
        title: "A",
        content: "a",
        type: "feature",
        publishedAt: "2026-04-01T00:00:00Z",
        fetchedAt: "2026-04-03T00:00:00Z",
      },
      {
        id: "rel_bbb",
        sourceId: "src_1",
        title: "B",
        content: "b",
        type: "feature",
        publishedAt: "2026-04-01T00:00:00Z",
        fetchedAt: "2026-04-02T00:00:00Z",
      },
      {
        id: "rel_ccc",
        sourceId: "src_1",
        title: "C",
        content: "c",
        type: "feature",
        publishedAt: "2026-04-01T00:00:00Z",
        fetchedAt: "2026-04-02T00:00:00Z",
      },
    ]);

    const page1 = await getCollectionReleasesFeed(asD1(db), ["org_1"], null, 2);
    expect(page1.map((r) => r.id)).toEqual(["rel_aaa", "rel_ccc"]);

    const last = page1[page1.length - 1]!;
    const cursor = buildFeedCursor(last);
    const page2 = await getCollectionReleasesFeed(asD1(db), ["org_1"], cursor, 2);
    expect(page2.map((r) => r.id)).toEqual(["rel_bbb"]);
  });

  /**
   * Legacy two-segment cursors emitted before this deploy must keep
   * working. They retain the prior tie-on-id behavior (which is exactly
   * the bug — but in-flight paginators were already exposed to it, so
   * accepting the shape is strictly back-compat).
   */
  it("accepts a legacy publishedAt|id cursor without erroring", async () => {
    const db = tdb.db;
    await db
      .insert(organizations)
      .values({ id: "org_1", name: "Org", slug: "org-legacy", discovery: "curated" });
    await db.insert(sources).values({
      id: "src_1",
      name: "S",
      slug: "src-1",
      type: "github",
      url: "https://github.com/x/src-1",
      orgId: "org_1",
      discovery: "curated",
    });
    await db.insert(releases).values([
      {
        id: "rel_old",
        sourceId: "src_1",
        title: "Old",
        content: "old",
        type: "feature",
        publishedAt: "2026-03-01T00:00:00Z",
        fetchedAt: "2026-03-01T00:00:00Z",
      },
    ]);

    const rows = await getCollectionReleasesFeed(
      asD1(db),
      ["org_1"],
      "2026-04-01T00:00:00Z|rel_zzz",
      10,
    );
    expect(rows.map((r) => r.id)).toEqual(["rel_old"]);
  });

  /**
   * The ORDER BY puts dated rows before undated ones. Without `r.published_at
   * IS NULL OR …` in the dated-cursor branches, paginating past the last
   * dated row would silently drop every undated release. Page 1 takes both
   * dated rows; page 2 (cursor anchored at the last dated row) must surface
   * the two undated rows.
   */
  it("advances from the dated tail into the null-published rows", async () => {
    const db = tdb.db;
    await db
      .insert(organizations)
      .values({ id: "org_1", name: "Org", slug: "org-mixed", discovery: "curated" });
    await db.insert(sources).values({
      id: "src_1",
      name: "S",
      slug: "src-1",
      type: "github",
      url: "https://github.com/x/src-1",
      orgId: "org_1",
      discovery: "curated",
    });
    await db.insert(releases).values([
      {
        id: "rel_dated_a",
        sourceId: "src_1",
        title: "Dated A",
        content: "a",
        type: "feature",
        publishedAt: "2026-04-02T00:00:00Z",
        fetchedAt: "2026-04-02T00:00:00Z",
      },
      {
        id: "rel_dated_b",
        sourceId: "src_1",
        title: "Dated B",
        content: "b",
        type: "feature",
        publishedAt: "2026-04-01T00:00:00Z",
        fetchedAt: "2026-04-01T00:00:00Z",
      },
      {
        id: "rel_null_x",
        sourceId: "src_1",
        title: "Undated X",
        content: "x",
        type: "feature",
        publishedAt: null,
        fetchedAt: "2026-04-05T00:00:00Z",
      },
      {
        id: "rel_null_y",
        sourceId: "src_1",
        title: "Undated Y",
        content: "y",
        type: "feature",
        publishedAt: null,
        fetchedAt: "2026-04-04T00:00:00Z",
      },
    ]);

    const page1 = await getCollectionReleasesFeed(asD1(db), ["org_1"], null, 2);
    expect(page1.map((r) => r.id)).toEqual(["rel_dated_a", "rel_dated_b"]);

    const cursor = buildFeedCursor(page1[page1.length - 1]!);
    const page2 = await getCollectionReleasesFeed(asD1(db), ["org_1"], cursor, 2);
    expect(page2.map((r) => r.id)).toEqual(["rel_null_x", "rel_null_y"]);
  });
});
