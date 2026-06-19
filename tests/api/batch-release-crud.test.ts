/**
 * DELETE /releases/batch and POST /releases/batch-suppress — chunked bulk
 * mutations for curator cleanup. Mirrors single-row delete/suppress semantics:
 * idempotent skips for unknown ids, cache purge on visibility change.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, clearAllTables, type TestDatabase } from "../db-helper.js";
import { sourceRoutes } from "../../workers/api/src/routes/sources.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";

let testDb: TestDatabase;

function seedRelease(id: string, opts?: { suppressed?: boolean }) {
  testDb.db
    .insert(releases)
    .values({
      id,
      sourceId: "src_a1",
      title: id,
      version: "1.0.0",
      content: "body",
      url: `https://acme.test/${id}`,
      contentHash: `hash_${id}`,
      publishedAt: "2026-01-01",
      type: "feature",
      suppressed: opts?.suppressed ?? false,
    })
    .run();
}

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

function makeEnv(kv?: ReturnType<typeof makeKv>) {
  return {
    DB: testDb.db as unknown as D1Database,
    ...(kv ? { LATEST_CACHE: kv as unknown as KVNamespace, INVALIDATION_ENABLED: "true" } : {}),
  };
}

const noopCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

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

describe("DELETE /releases/batch", () => {
  it("deletes existing rows and skips unknown ids", async () => {
    seedRelease("rel_a");
    seedRelease("rel_b");

    const res = await sourceRoutes.request(
      "/releases/batch",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ releaseIds: ["rel_a", "rel_missing", "rel_b"] }),
      },
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2 });

    const rows = await testDb.db.select().from(releases);
    expect(rows).toHaveLength(0);
  });

  it("returns deleted: 0 when every id is unknown", async () => {
    const res = await sourceRoutes.request(
      "/releases/batch",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ releaseIds: ["rel_missing"] }),
      },
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 0 });
  });

  it("400 when releaseIds is empty", async () => {
    const res = await sourceRoutes.request(
      "/releases/batch",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ releaseIds: [] }),
      },
      makeEnv(),
    );

    expect(res.status).toBe(400);
  });
});

describe("POST /releases/batch-suppress", () => {
  it("suppresses listed releases with an optional reason", async () => {
    seedRelease("rel_a");
    seedRelease("rel_b");

    const res = await sourceRoutes.request(
      "/releases/batch-suppress",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          releaseIds: ["rel_a", "rel_missing"],
          suppressed: true,
          reason: "spam",
        }),
      },
      makeEnv(),
      noopCtx as never,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 1 });

    const [row] = await testDb.db.select().from(releases).where(eq(releases.id, "rel_a"));
    expect(row?.suppressed).toBe(true);
    expect(row?.suppressedReason).toBe("spam");

    const [untouched] = await testDb.db.select().from(releases).where(eq(releases.id, "rel_b"));
    expect(untouched?.suppressed).toBe(false);
  });

  it("unsuppresses listed releases and clears the reason", async () => {
    seedRelease("rel_a", { suppressed: true });

    const res = await sourceRoutes.request(
      "/releases/batch-suppress",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ releaseIds: ["rel_a"], suppressed: false }),
      },
      makeEnv(),
      noopCtx as never,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 1 });

    const [row] = await testDb.db.select().from(releases).where(eq(releases.id, "rel_a"));
    expect(row?.suppressed).toBe(false);
    expect(row?.suppressedReason).toBeNull();
  });

  it("purges homepage reel caches when any row changes visibility", async () => {
    seedRelease("rel_a");
    const kv = makeKv();
    const { ctx, waitUntilCalls } = makeExecutionCtx();

    const res = await sourceRoutes.request(
      "/releases/batch-suppress",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ releaseIds: ["rel_a"], suppressed: true }),
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

  it("does not invalidate when every id is unknown", async () => {
    const kv = makeKv();
    const { ctx, waitUntilCalls } = makeExecutionCtx();

    const res = await sourceRoutes.request(
      "/releases/batch-suppress",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ releaseIds: ["rel_missing"], suppressed: true }),
      },
      makeEnv(kv),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 0 });
    expect(waitUntilCalls).toHaveLength(0);
    expect(kv.delete).not.toHaveBeenCalled();
  });
});
