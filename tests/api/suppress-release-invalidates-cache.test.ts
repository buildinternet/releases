/**
 * POST /releases/:id/suppress and /unsuppress must purge the `/v1/releases/latest`
 * + GraphQL homepage-ticker KV caches. Without the purge, a freshly-suppressed
 * release stays in the homepage `RECENT` reel for the 5-minute TTL window;
 * clicks fall through to `/release/:id`, which 404s via `releases_visible`.
 *
 * Strategy: stub `LATEST_CACHE` and assert `kv.delete` fires for every key
 * `invalidateLatestCache` is expected to purge. Drains `executionCtx.waitUntil`
 * promises before asserting because the route fires the invalidation async.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { sql } from "drizzle-orm";
import { createTestDb, clearAllTables, type TestDatabase } from "../db-helper.js";
import { sourceRoutes } from "../../workers/api/src/routes/sources.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
  clearAllTables(testDb.db);

  testDb.db.insert(organizations).values({ id: "org_a", name: "Acme", slug: "acme" }).run();

  testDb.db
    .insert(sources)
    .values({
      id: "src_a1",
      orgId: "org_a",
      slug: "acme-src",
      name: "Acme Source",
      url: "https://acme.test/releases",
      type: "github",
      metadata: "{}",
    })
    .run();

  testDb.db
    .insert(releases)
    .values({
      id: "rel_test1",
      sourceId: "src_a1",
      title: "v1.0.0",
      version: "1.0.0",
      content: "Initial release",
      url: "https://acme.test/releases/v1.0.0",
      contentHash: "abc123",
      publishedAt: "2026-01-01",
      type: "feature",
    })
    .run();
});

afterEach(() => {
  testDb.cleanup();
});

function makeKv() {
  return {
    get: mock(async () => null),
    put: mock(async () => undefined),
    delete: mock(async () => undefined),
  };
}

function makeEnv(kv: ReturnType<typeof makeKv>) {
  return {
    DB: testDb.db as unknown as D1Database,
    LATEST_CACHE: kv as unknown as KVNamespace,
    INVALIDATION_ENABLED: "true",
  };
}

function makeExecutionCtx() {
  const waitUntilCalls: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      waitUntilCalls.push(p);
    },
    passThroughOnException() {},
  } as never;
  return { ctx, waitUntilCalls };
}

describe("POST /releases/:id/suppress — homepage reel cache invalidation", () => {
  it("purges every cacheable latest-feed shape after suppressing", async () => {
    const kv = makeKv();
    const { ctx, waitUntilCalls } = makeExecutionCtx();

    const res = await sourceRoutes.request(
      "/releases/rel_test1/suppress",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "spam" }),
      },
      makeEnv(kv),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(waitUntilCalls).toHaveLength(1);
    await Promise.all(waitUntilCalls);

    expect(kv.delete).toHaveBeenCalledWith("latest:v2:count=10");
    expect(kv.delete).toHaveBeenCalledWith("latest:v2:count=20&exclude=github");
  });

  it("does not invalidate when the release id is unknown", async () => {
    const kv = makeKv();
    const { ctx, waitUntilCalls } = makeExecutionCtx();

    const res = await sourceRoutes.request(
      "/releases/rel_missing/suppress",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "spam" }),
      },
      makeEnv(kv),
      ctx,
    );

    expect(res.status).toBe(404);
    expect(waitUntilCalls).toHaveLength(0);
    expect(kv.delete).not.toHaveBeenCalled();
  });
});

describe("POST /releases/:id/unsuppress — homepage reel cache invalidation", () => {
  it("purges every cacheable latest-feed shape after unsuppressing", async () => {
    testDb.db
      .update(releases)
      .set({ suppressed: true, suppressedReason: "spam" })
      .where(sql`id = 'rel_test1'`)
      .run();

    const kv = makeKv();
    const { ctx, waitUntilCalls } = makeExecutionCtx();

    const res = await sourceRoutes.request(
      "/releases/rel_test1/unsuppress",
      { method: "POST" },
      makeEnv(kv),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(waitUntilCalls).toHaveLength(1);
    await Promise.all(waitUntilCalls);

    expect(kv.delete).toHaveBeenCalledWith("latest:v2:count=10");
    expect(kv.delete).toHaveBeenCalledWith("latest:v2:count=20&exclude=github");
  });
});
