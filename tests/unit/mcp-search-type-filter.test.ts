/**
 * Tests for the `type` filter in `buildReleaseHits` (MCP hybrid search).
 *
 * Regression for issue #863: `runHybridSearch` accepted a `type` param but
 * `buildReleaseHits` never applied it, so rollup releases leaked through even
 * when the caller passed `type: "feature"`.
 *
 * Without Vectorize bindings the hybrid and semantic paths degrade to lexical,
 * so all three modes exercise the same `buildReleaseHits` post-filter. This is
 * sufficient to cover the regression: the missing guard was in that function,
 * not in the vector path.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { newOrgId, newSourceId, newReleaseId } from "@buildinternet/releases-core/id";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { asD1 } from "../mcp-test-helpers.js";
import { runHybridSearch } from "../../workers/mcp/src/lib/search-hybrid.js";
import type { HybridSearchEnv } from "../../workers/mcp/src/lib/search-hybrid.js";

/** Minimal env — no Vectorize or embedding provider, so hybrid/semantic degrade to lexical. */
const minimalEnv: HybridSearchEnv = {};

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

async function seedFixture(db: TestDatabase["db"]) {
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

  const featureId = newReleaseId();
  const rollupId = newReleaseId();

  // Both releases share "quantum" in their title so FTS returns both.
  await db.insert(releases).values([
    {
      id: featureId,
      sourceId: srcId,
      title: "quantum feature release",
      content: "shipped quantum improvements",
      publishedAt: "2026-04-01T00:00:00Z",
      type: "feature",
    },
    {
      id: rollupId,
      sourceId: srcId,
      title: "quantum rollup release",
      content: "quarterly quantum catch-all",
      publishedAt: "2026-04-02T00:00:00Z",
      type: "rollup",
    },
  ]);

  return { featureId, rollupId };
}

describe("runHybridSearch — type filter in buildReleaseHits", () => {
  it("lexical mode: returns both releases when type is unset", async () => {
    const { featureId, rollupId } = await seedFixture(testDb.db);
    const db = asD1(testDb.db);

    const result = await runHybridSearch(minimalEnv, db, {
      query: "quantum",
      mode: "lexical",
    });

    const ids = result.hits
      .filter((h) => h.kind === "release")
      .map((h) => (h.kind === "release" ? h.release.id : null));
    expect(ids).toContain(featureId);
    expect(ids).toContain(rollupId);
  });

  it("lexical mode: type='feature' excludes the rollup release", async () => {
    const { featureId, rollupId } = await seedFixture(testDb.db);
    const db = asD1(testDb.db);

    const result = await runHybridSearch(minimalEnv, db, {
      query: "quantum",
      mode: "lexical",
      type: "feature",
    });

    const ids = result.hits
      .filter((h) => h.kind === "release")
      .map((h) => (h.kind === "release" ? h.release.id : null));
    expect(ids).toContain(featureId);
    expect(ids).not.toContain(rollupId);
  });

  it("lexical mode: type='rollup' excludes the feature release", async () => {
    const { featureId, rollupId } = await seedFixture(testDb.db);
    const db = asD1(testDb.db);

    const result = await runHybridSearch(minimalEnv, db, {
      query: "quantum",
      mode: "lexical",
      type: "rollup",
    });

    const ids = result.hits
      .filter((h) => h.kind === "release")
      .map((h) => (h.kind === "release" ? h.release.id : null));
    expect(ids).not.toContain(featureId);
    expect(ids).toContain(rollupId);
  });

  it("hybrid mode (degrades to lexical): type='feature' excludes the rollup release", async () => {
    const { featureId, rollupId } = await seedFixture(testDb.db);
    const db = asD1(testDb.db);

    // No RELEASES_INDEX or embedder → degrades to lexical; still exercises buildReleaseHits.
    const result = await runHybridSearch(minimalEnv, db, {
      query: "quantum",
      mode: "hybrid",
      type: "feature",
    });

    expect(result.degraded).toBe(true);
    const ids = result.hits
      .filter((h) => h.kind === "release")
      .map((h) => (h.kind === "release" ? h.release.id : null));
    expect(ids).toContain(featureId);
    expect(ids).not.toContain(rollupId);
  });

  it("semantic mode (degrades to lexical): type='feature' excludes the rollup release", async () => {
    const { featureId, rollupId } = await seedFixture(testDb.db);
    const db = asD1(testDb.db);

    // No RELEASES_INDEX or embedder → degrades to lexical; still exercises buildReleaseHits.
    const result = await runHybridSearch(minimalEnv, db, {
      query: "quantum",
      mode: "semantic",
      type: "feature",
    });

    expect(result.degraded).toBe(true);
    const ids = result.hits
      .filter((h) => h.kind === "release")
      .map((h) => (h.kind === "release" ? h.release.id : null));
    expect(ids).toContain(featureId);
    expect(ids).not.toContain(rollupId);
  });
});
