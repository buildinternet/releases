/**
 * Regression for issue #1043: each of `runHybridSearch`, `runCollectionsSemantic`,
 * and `runRegistrySearch` used to call `buildEmbedConfig` independently. The
 * default `/v1/search` path runs the first two in `Promise.all`, so a single
 * request resolved the Secrets Store binding twice.
 *
 * `HybridSearchOpts.embedConfig` lets the caller resolve once and hand the
 * result to every helper. This test asserts:
 *   1. When opts.embedConfig is provided, the wrapper's buildEmbedConfig is
 *      not called.
 *   2. When opts.embedConfig is null (caller resolved "no provider"), the
 *      helper still skips the wrapper's buildEmbedConfig and degrades.
 *   3. When opts.embedConfig is omitted, the wrapper's buildEmbedConfig is
 *      called (back-compat with the original API).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { newOrgId, newSourceId, newReleaseId } from "@buildinternet/releases-core/id";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { asD1 } from "../mcp-test-helpers.js";
import {
  createWorkerSearch,
  type HybridSearchEnv,
  type ResolvedEmbedConfig,
} from "@releases/search/hybrid-search-worker";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

const minimalEnv: HybridSearchEnv = {};

async function seedOne(db: TestDatabase["db"]) {
  const orgId = newOrgId();
  await db.insert(organizations).values({ id: orgId, name: "Acme", slug: "acme" });
  const srcId = newSourceId();
  await db.insert(sources).values({
    id: srcId,
    orgId,
    name: "Acme",
    slug: "acme-src",
    type: "github",
    url: "https://github.com/acme/acme",
    discovery: "curated",
  });
  await db.insert(releases).values({
    id: newReleaseId(),
    sourceId: srcId,
    title: "memoizable release",
    content: "memoizable body",
    publishedAt: "2026-04-01T00:00:00Z",
    type: "feature",
  });
}

function makeSpyBuildEmbedConfig() {
  let calls = 0;
  const spy = async () => {
    calls++;
    return null;
  };
  return {
    fn: spy,
    get calls() {
      return calls;
    },
  };
}

const FAKE_CFG: ResolvedEmbedConfig = {
  provider: "voyage",
  model: "voyage-4-lite",
  apiKey: "fake",
};

describe("buildEmbedder — opts.embedConfig short-circuits the wrapper's buildEmbedConfig", () => {
  it("skips buildEmbedConfig when opts.embedConfig is a resolved config", async () => {
    await seedOne(testDb.db);
    const db = asD1(testDb.db);
    const spy = makeSpyBuildEmbedConfig();
    const { runHybridSearch } = createWorkerSearch(spy.fn);

    // No Vectorize bindings → vector path can't run, so even though we
    // "have" a config, hybrid degrades to lexical. The bit that matters
    // for this test is that the wrapper never called spy.fn.
    await runHybridSearch(
      minimalEnv,
      db,
      { query: "memoizable", mode: "hybrid" },
      { embedConfig: FAKE_CFG },
    );

    expect(spy.calls).toBe(0);
  });

  it("skips buildEmbedConfig when opts.embedConfig is null (caller resolved 'no provider')", async () => {
    await seedOne(testDb.db);
    const db = asD1(testDb.db);
    const spy = makeSpyBuildEmbedConfig();
    const { runHybridSearch } = createWorkerSearch(spy.fn);

    const result = await runHybridSearch(
      minimalEnv,
      db,
      { query: "memoizable", mode: "hybrid" },
      { embedConfig: null },
    );

    expect(spy.calls).toBe(0);
    expect(result.degraded).toBe(true);
  });

  it("falls back to buildEmbedConfig when opts.embedConfig is omitted", async () => {
    await seedOne(testDb.db);
    const db = asD1(testDb.db);
    const spy = makeSpyBuildEmbedConfig();
    const { runHybridSearch } = createWorkerSearch(spy.fn);

    await runHybridSearch(minimalEnv, db, { query: "memoizable", mode: "hybrid" });

    expect(spy.calls).toBe(1);
  });

  it("runHybridSearch + runCollectionsSemantic together resolve embedConfig at most once when shared", async () => {
    await seedOne(testDb.db);
    const db = asD1(testDb.db);
    const spy = makeSpyBuildEmbedConfig();
    const { runHybridSearch, runCollectionsSemantic } = createWorkerSearch(spy.fn);

    // Simulates the /v1/search route: resolve once in the route, pass to both.
    await Promise.all([
      runHybridSearch(
        minimalEnv,
        db,
        { query: "memoizable", mode: "hybrid" },
        { embedConfig: FAKE_CFG },
      ),
      runCollectionsSemantic(minimalEnv, db, { query: "memoizable" }, { embedConfig: FAKE_CFG }),
    ]);

    expect(spy.calls).toBe(0);
  });

  it("without sharing, each helper independently invokes buildEmbedConfig (regression baseline)", async () => {
    await seedOne(testDb.db);
    const db = asD1(testDb.db);
    const spy = makeSpyBuildEmbedConfig();
    const { runHybridSearch, runCollectionsSemantic } = createWorkerSearch(spy.fn);

    await Promise.all([
      runHybridSearch(minimalEnv, db, { query: "memoizable", mode: "hybrid" }),
      runCollectionsSemantic(minimalEnv, db, { query: "memoizable" }),
    ]);

    // Documents the cost the embedConfig opt is designed to avoid.
    expect(spy.calls).toBe(2);
  });
});
