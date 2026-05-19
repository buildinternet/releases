/**
 * Regression for issue #1042: `hydrateReleases` (and the related `inArray`
 * paths) used to build a single `IN (...)` clause from every fused-result id,
 * which blows past D1's 100-bind-per-statement cap once `/v1/search` runs at
 * `limit = 100` (topK * 3 = 300 ids feed into hydration).
 *
 * bun:sqlite doesn't enforce the same cap, so a "shouldn't throw" assertion
 * isn't enough — instead we seed >D1's cap worth of matching releases and
 * verify they ALL hydrate. A regression that lost ids inside the chunking
 * (off-by-one, missing flat, wrong Map merge) would surface here.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { newOrgId, newSourceId, newReleaseId } from "@buildinternet/releases-core/id";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { asD1 } from "../mcp-test-helpers.js";
import { runHybridSearch } from "../../workers/mcp/src/lib/search-hybrid.js";
import type { HybridSearchEnv } from "../../workers/mcp/src/lib/search-hybrid.js";

const minimalEnv: HybridSearchEnv = {};

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

const TOKEN = "quantumflux";
const FIXTURE_SIZE = 120; // > D1's 100-bind cap; forces at least 2 chunks.

async function seedManyMatchingReleases(db: TestDatabase["db"]): Promise<string[]> {
  const orgId = newOrgId();
  await db.insert(organizations).values({ id: orgId, name: "Acme", slug: "acme" });

  const srcId = newSourceId();
  await db.insert(sources).values({
    id: srcId,
    orgId,
    name: "Acme Releases",
    slug: "acme-releases",
    type: "github",
    url: "https://github.com/acme/releases",
    discovery: "curated",
  });

  const ids: string[] = [];
  const rows = Array.from({ length: FIXTURE_SIZE }, (_, i) => {
    const id = newReleaseId();
    ids.push(id);
    return {
      id,
      sourceId: srcId,
      title: `${TOKEN} release ${i}`,
      content: `${TOKEN} release body ${i}`,
      publishedAt: `2026-04-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      type: "feature" as const,
    };
  });
  // Insert in batches small enough for bun:sqlite — drizzle's insert in one
  // statement would itself trip param caps on a real D1.
  const batches: (typeof rows)[] = [];
  for (let i = 0; i < rows.length; i += 30) batches.push(rows.slice(i, i + 30));
  await Promise.all(batches.map((batch) => db.insert(releases).values(batch)));
  return ids;
}

describe("runHybridSearch — hydrate chunking under heavy fan-out", () => {
  it("returns the full limit-sized hit set when topK*3 exceeds D1's bind cap", async () => {
    const seededIds = await seedManyMatchingReleases(testDb.db);
    const db = asD1(testDb.db);

    // limit=100 → topK*3=300 ids feed into hydrateReleases. Pre-fix, a single
    // IN clause carried 300 binds and D1 rejected the prepared statement.
    const result = await runHybridSearch(minimalEnv, db, {
      query: TOKEN,
      mode: "lexical",
      topK: 100,
    });

    type Hit = (typeof result.hits)[number];
    type ReleaseHit = Extract<Hit, { kind: "release" }>;
    const ids = result.hits
      .filter((h: Hit): h is ReleaseHit => h.kind === "release")
      .map((h: ReleaseHit) => h.release.id);

    // FTS rank order isn't deterministic across the seeded fixture, but every
    // hit must be one of the seeded ids and we must get the full requested
    // page (the underlying set has 120, well over the 100 limit).
    expect(ids).toHaveLength(100);
    const seededSet = new Set(seededIds);
    for (const id of ids) {
      expect(seededSet.has(id)).toBe(true);
    }
    // Distinct ids — no duplicates introduced by the chunked merge.
    expect(new Set(ids).size).toBe(ids.length);
  });
});
