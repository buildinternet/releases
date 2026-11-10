/**
 * `source_release_stats` is maintained by SQLite triggers (migration
 * 20261104230000) and must always equal what `releases_visible` aggregates to:
 * not suppressed, not the coverage side of a link. These tests drive every
 * write that changes visibility and compare the table with a fresh aggregate.
 */
import { describe, it, expect } from "bun:test";
import { sql } from "drizzle-orm";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { releaseCoverage } from "@releases/core-internal/schema-coverage";
import { RELEASE_URL_UPSERT } from "@releases/core-internal/release-upsert";
import { createTestDb } from "../../../tests/db-helper.js";
import { reconcileSourceReleaseStats } from "../src/queries/source-release-stats.js";

const NOW = "2026-11-04T00:00:00.000Z";

type Db = ReturnType<typeof createTestDb>["db"];
async function first<T>(db: Db, q: ReturnType<typeof sql>): Promise<T> {
  const rows = (await db.all(q)) as T[];
  return rows[0] as T;
}

async function setup() {
  const { db } = createTestDb();
  await db.insert(organizations).values({ id: "org_a", slug: "acme", name: "Acme" });
  await db.insert(sources).values(
    ["src_a", "src_b"].map((id) => ({
      id,
      orgId: "org_a",
      slug: id,
      name: id,
      type: "feed" as const,
      url: `https://${id}.test`,
      createdAt: NOW,
    })),
  );
  const rel = (id: string, publishedAt: string | null, extra: Record<string, unknown> = {}) =>
    db.insert(releases).values({
      id,
      sourceId: "src_a",
      title: id,
      content: "",
      url: `https://src_a.test/${id}`,
      publishedAt,
      fetchedAt: NOW,
      ...extra,
    });
  const stats = (sourceId = "src_a") =>
    first<{ c: number; f: string | null; l: string | null } | undefined>(
      db,
      sql`SELECT release_count AS c, first_published_at AS f, last_published_at AS l
          FROM source_release_stats WHERE source_id = ${sourceId}`,
    );
  const expected = (sourceId = "src_a") =>
    first<{ c: number; f: string | null; l: string | null }>(
      db,
      sql`SELECT COUNT(*) AS c, MIN(published_at) AS f, MAX(published_at) AS l
          FROM releases_visible WHERE source_id = ${sourceId}`,
    );
  const assertInSync = async () => {
    for (const id of ["src_a", "src_b"]) {
      const got = (await stats(id)) ?? { c: 0, f: null, l: null };
      expect(got).toEqual(await expected(id));
    }
  };
  return { db, rel, stats, assertInSync };
}

describe("source_release_stats triggers", () => {
  it("counts visible inserts and tracks first/last published_at", async () => {
    const { rel, stats, assertInSync } = await setup();
    await rel("r1", "2026-01-02");
    await rel("r2", "2026-03-01");
    await rel("r3", null);
    await rel("r4", "2025-01-01", { suppressed: 1 });
    expect(await stats()).toEqual({ c: 3, f: "2026-01-02", l: "2026-03-01" });
    await assertInSync();
  });

  it("follows coverage link, unlink and suppress/unsuppress", async () => {
    const { db, rel, assertInSync } = await setup();
    await rel("r1", "2026-01-02");
    await rel("r2", "2026-03-01");
    await rel("r3", "2025-01-01", { suppressed: 1 });
    await db
      .insert(releaseCoverage)
      .values({ coverageId: "r2", canonicalId: "r1", decidedBy: "test", decidedAt: NOW });
    await assertInSync();
    await db.run(sql`DELETE FROM release_coverage WHERE coverage_id = 'r2'`);
    await assertInSync();
    await db.run(sql`UPDATE releases SET suppressed = 0 WHERE id = 'r3'`);
    await assertInSync();
    await db.run(sql`UPDATE releases SET suppressed = 1 WHERE id = 'r1'`);
    await assertInSync();
  });

  it("updates incrementally on a batch coverage insert, including first/last and suppressed rows", async () => {
    const { db, rel, stats, assertInSync } = await setup();
    await rel("r1", "2026-01-01");
    await rel("r2", "2026-02-01");
    await rel("r3", "2026-02-01");
    await rel("r4", "2026-03-01");
    await rel("r5", null);
    await rel("r6", "2026-04-01", { suppressed: 1 });
    // r1 holds first, r4 holds last, r3 ties r2's date, r5 is undated, r6 was
    // never counted (suppressed).
    await db.insert(releaseCoverage).values(
      ["r1", "r3", "r4", "r5", "r6"].map((coverageId) => ({
        coverageId,
        canonicalId: "r2",
        decidedBy: "test",
        decidedAt: NOW,
      })),
    );
    expect(await stats()).toEqual({ c: 1, f: "2026-02-01", l: "2026-02-01" });
    await assertInSync();
  });

  it("clears first/last when the last visible dated release is covered", async () => {
    const { db, rel, stats, assertInSync } = await setup();
    await rel("r1", "2026-01-01");
    await rel("r2", null);
    await db
      .insert(releaseCoverage)
      .values({ coverageId: "r1", canonicalId: "r2", decidedBy: "test", decidedAt: NOW });
    expect(await stats()).toEqual({ c: 1, f: null, l: null });
    await assertInSync();
  });

  it("handles deletes, including a covered release and a cascading source delete", async () => {
    const { db, rel, stats, assertInSync } = await setup();
    await rel("r1", "2026-01-02");
    await rel("r2", "2026-03-01");
    await db
      .insert(releaseCoverage)
      .values({ coverageId: "r2", canonicalId: "r1", decidedBy: "test", decidedAt: NOW });
    await db.run(sql`DELETE FROM releases WHERE id = 'r2'`);
    await assertInSync();
    await db.run(sql`DELETE FROM releases WHERE id = 'r1'`);
    expect(await stats()).toEqual({ c: 0, f: null, l: null });
    await rel("r5", "2026-05-01");
    await db.run(sql`DELETE FROM sources WHERE id = 'src_a'`);
    expect(await stats()).toBeUndefined();
  });

  it("follows published_at edits and moves between sources", async () => {
    const { db, rel, assertInSync } = await setup();
    await rel("r1", "2026-01-02");
    await rel("r2", "2026-03-01");
    await db.run(sql`UPDATE releases SET published_at = '2027-01-01' WHERE id = 'r1'`);
    await assertInSync();
    await db.run(sql`UPDATE releases SET source_id = 'src_b' WHERE id = 'r2'`);
    await assertInSync();
  });

  it("is untouched by an upsert that only backfills content", async () => {
    const { db, rel, stats } = await setup();
    await rel("r1", "2026-01-02");
    const before = await first<{ u: string }>(
      db,
      sql`SELECT updated_at AS u FROM source_release_stats WHERE source_id = 'src_a'`,
    );
    await db
      .insert(releases)
      .values({
        id: "r1-dup",
        sourceId: "src_a",
        title: "r1",
        content: "now with a body",
        url: "https://src_a.test/r1",
        publishedAt: "2026-01-02",
        fetchedAt: NOW,
      })
      .onConflictDoUpdate(RELEASE_URL_UPSERT);
    expect(await stats()).toEqual({ c: 1, f: "2026-01-02", l: "2026-01-02" });
    const after = await first<{ u: string }>(
      db,
      sql`SELECT updated_at AS u FROM source_release_stats WHERE source_id = 'src_a'`,
    );
    expect(after).toEqual(before);
  });
});

describe("reconcileSourceReleaseStats", () => {
  it("reports zero drift when the triggers kept up, and repairs a corrupted row", async () => {
    const { db, rel, assertInSync } = await setup();
    await rel("r1", "2026-01-02");
    await rel("r2", "2026-03-01");
    const d1 = db as unknown as D1Database;
    expect(await reconcileSourceReleaseStats(d1)).toEqual({ drifted: 0 });

    await db.run(sql`UPDATE source_release_stats SET release_count = 99 WHERE source_id = 'src_a'`);
    expect(await reconcileSourceReleaseStats(d1)).toEqual({ drifted: 1 });
    await assertInSync();
    expect(await reconcileSourceReleaseStats(d1)).toEqual({ drifted: 0 });
  });
});
