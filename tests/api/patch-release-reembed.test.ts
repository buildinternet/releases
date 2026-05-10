/**
 * Tests for the PATCH /sources/:slug/releases/:id re-embed side effect (#864).
 *
 * The PATCH handler calls `embedReleasesForSource` via `c.executionCtx.waitUntil`
 * whenever any of the embedding-relevant fields (content, title, summary,
 * titleGenerated, titleShort) are included in the request body.
 * Metadata-only edits (version, url, publishedAt, contentHash) must NOT
 * trigger a re-embed.
 *
 * Strategy: track `waitUntil` calls via a spy. A content-bearing PATCH
 * enqueues exactly one promise (the `embedReleasesForSource` call); a
 * metadata-only PATCH enqueues nothing.  We don't need Vectorize or Voyage
 * in-the-loop — `embedReleasesForSource` early-exits when the env has no
 * embedding config, so the side effect is fire-and-forget and silent.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
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

/** Minimal env: passes a pre-built drizzle handle so createDb passes it through unchanged. */
function makeEnv() {
  return {
    DB: testDb.db as unknown as D1Database,
    // No RELEASES_INDEX or embedding keys — embedReleasesForSource exits early,
    // but waitUntil is still called so we can assert on it.
  };
}

/**
 * Returns a spy-based ExecutionContext and the list of promises handed to
 * waitUntil so tests can assert call count.
 */
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

async function patchRelease(
  id: string,
  body: Record<string, unknown>,
  executionCtx: ReturnType<typeof makeExecutionCtx>["ctx"],
) {
  return sourceRoutes.request(
    `/releases/${id}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    makeEnv(),
    executionCtx,
  );
}

describe("PATCH /sources/:slug/releases/:id — re-embed side effect", () => {
  it("triggers waitUntil when `content` changes", async () => {
    const { ctx, waitUntilCalls } = makeExecutionCtx();
    const res = await patchRelease("rel_test1", { content: "Updated body" }, ctx);
    expect(res.status).toBe(200);
    expect(waitUntilCalls).toHaveLength(1);
  });

  it("triggers waitUntil when `title` changes", async () => {
    const { ctx, waitUntilCalls } = makeExecutionCtx();
    const res = await patchRelease("rel_test1", { title: "v1.0.1" }, ctx);
    expect(res.status).toBe(200);
    expect(waitUntilCalls).toHaveLength(1);
  });

  it("triggers waitUntil when `summary` changes", async () => {
    const { ctx, waitUntilCalls } = makeExecutionCtx();
    const res = await patchRelease("rel_test1", { summary: "AI-generated summary" }, ctx);
    expect(res.status).toBe(200);
    expect(waitUntilCalls).toHaveLength(1);
  });

  it("triggers waitUntil when `titleGenerated` changes", async () => {
    const { ctx, waitUntilCalls } = makeExecutionCtx();
    const res = await patchRelease("rel_test1", { titleGenerated: "AI headline" }, ctx);
    expect(res.status).toBe(200);
    expect(waitUntilCalls).toHaveLength(1);
  });

  it("triggers waitUntil when `titleShort` changes", async () => {
    const { ctx, waitUntilCalls } = makeExecutionCtx();
    const res = await patchRelease("rel_test1", { titleShort: "Short AI" }, ctx);
    expect(res.status).toBe(200);
    expect(waitUntilCalls).toHaveLength(1);
  });

  it("triggers waitUntil when null clears `summary`", async () => {
    const { ctx, waitUntilCalls } = makeExecutionCtx();
    const res = await patchRelease("rel_test1", { summary: null }, ctx);
    expect(res.status).toBe(200);
    expect(waitUntilCalls).toHaveLength(1);
  });

  it("does NOT trigger waitUntil for metadata-only edits (version)", async () => {
    const { ctx, waitUntilCalls } = makeExecutionCtx();
    const res = await patchRelease("rel_test1", { version: "1.0.1" }, ctx);
    expect(res.status).toBe(200);
    expect(waitUntilCalls).toHaveLength(0);
  });

  it("does NOT trigger waitUntil for metadata-only edits (publishedAt)", async () => {
    const { ctx, waitUntilCalls } = makeExecutionCtx();
    const res = await patchRelease("rel_test1", { publishedAt: "2026-02-01" }, ctx);
    expect(res.status).toBe(200);
    expect(waitUntilCalls).toHaveLength(0);
  });

  it("does NOT trigger waitUntil for metadata-only edits (url)", async () => {
    const { ctx, waitUntilCalls } = makeExecutionCtx();
    const res = await patchRelease("rel_test1", { url: "https://acme.test/releases/v1.0.1" }, ctx);
    expect(res.status).toBe(200);
    expect(waitUntilCalls).toHaveLength(0);
  });

  it("does NOT trigger waitUntil for metadata-only edits (contentHash)", async () => {
    const { ctx, waitUntilCalls } = makeExecutionCtx();
    const res = await patchRelease("rel_test1", { contentHash: "newHash" }, ctx);
    expect(res.status).toBe(200);
    expect(waitUntilCalls).toHaveLength(0);
  });

  it("does NOT trigger waitUntil for metadata-only edits (version + publishedAt combined)", async () => {
    const { ctx, waitUntilCalls } = makeExecutionCtx();
    const res = await patchRelease(
      "rel_test1",
      { version: "1.0.2", publishedAt: "2026-03-01" },
      ctx,
    );
    expect(res.status).toBe(200);
    expect(waitUntilCalls).toHaveLength(0);
  });

  it("triggers waitUntil when mixed: one content field + metadata fields", async () => {
    const { ctx, waitUntilCalls } = makeExecutionCtx();
    const res = await patchRelease(
      "rel_test1",
      { version: "1.0.2", summary: "New AI summary" },
      ctx,
    );
    expect(res.status).toBe(200);
    expect(waitUntilCalls).toHaveLength(1);
  });

  it("returns 404 for unknown release id", async () => {
    const { ctx } = makeExecutionCtx();
    const res = await patchRelease("rel_does_not_exist", { title: "x" }, ctx);
    expect(res.status).toBe(404);
  });

  it("the DB update actually persists the change", async () => {
    const { ctx } = makeExecutionCtx();
    const res = await patchRelease("rel_test1", { title: "v2.0.0", version: "2.0.0" }, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string; version: string };
    expect(body.title).toBe("v2.0.0");
    expect(body.version).toBe("2.0.0");
  });
});
