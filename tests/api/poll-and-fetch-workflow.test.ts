import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { sources, organizations, releases, fetchLog } from "@buildinternet/releases-core/schema";
import { applyMigrations } from "../db-helper";
import { PollAndFetchWorkflow } from "../../workers/api/src/workflows/poll-and-fetch";
import type { PollAndFetchWorkflowEnv } from "../../workers/api/src/workflows/poll-and-fetch";

/**
 * Test harness for the Workflows-based poll-and-fetch path.
 *
 * Stubs are intentionally localized — earlier drafts used `mock.module(...)`
 * on `@releases/search/embed-releases` and `@releases/adapters/feed` but those
 * mocks leaked into sibling test files that import the same modules directly.
 * Instead, we stub `globalThis.fetch` for the two external endpoints and pass
 * a fake `VectorizeIndex` binding — no module-level mocks.
 */

// ── FakeWorkflowStep (mirrors phase 1 harness) ──

type StepRecord = { name: string; attempts: number; ok: boolean; error?: string };

function mkFakeStep() {
  const records: StepRecord[] = [];
  const step = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async do<T>(name: string, a: any, b?: any): Promise<T> {
      const config = typeof a === "object" && a !== null && !("call" in a) ? a : undefined;
      const cb = (b ?? a) as () => Promise<T>;
      const retryLimit =
        (config as { retries?: { limit: number } } | undefined)?.retries?.limit ?? 0;
      let attempts = 0;
      let lastError: unknown;
      for (let i = 0; i <= retryLimit; i++) {
        attempts++;
        try {
          // eslint-disable-next-line no-await-in-loop
          const result = await cb();
          records.push({ name, attempts, ok: true });
          return result;
        } catch (err) {
          lastError = err;
          const isNonRetryable =
            err instanceof Error && err.constructor.name === "NonRetryableError";
          if (isNonRetryable) break;
        }
      }
      records.push({
        name,
        attempts,
        ok: false,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      });
      throw lastError;
    },
    async sleep() {},
    async sleepUntil() {},
    async waitForEvent() {
      throw new Error("waitForEvent not expected");
    },
  };
  return { step, records };
}

// ── Fixtures ──

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  db.insert(organizations)
    .values({ id: "org_a", name: "Acme", slug: "acme", category: "cloud" })
    .run();
  db.insert(sources)
    .values({
      id: "src_a1",
      orgId: "org_a",
      slug: "acme-one",
      name: "Acme One",
      url: "https://a.test/feed",
      type: "feed",
      metadata: JSON.stringify({ feedUrl: "https://a.test/feed", feedType: "atom" }),
    })
    .run();
  return db;
}

/**
 * Build a fake fetch that serves:
 * - HEAD `https://a.test/feed` → 200 with an ETag (poll phase).
 * - GET `https://a.test/feed` → 200 with an Atom feed of `feedEntries`.
 * - POST `api.voyageai.com` → deterministic vectors unless `voyageBehavior`
 *   throws, in which case the rejection bubbles out of embedBatch.
 *
 * Anything else returns 404 so typos surface fast.
 */
function atomBody(entries: Array<{ id: string; title: string }>) {
  const items = entries
    .map(
      (e) =>
        `<entry><id>${e.id}</id><title>${e.title}</title><link href="${e.id}"/><updated>2026-01-01T00:00:00Z</updated><content>body</content></entry>`,
    )
    .join("");
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><id>acme</id><title>Acme</title>${items}</feed>`;
}

function mkFetch(opts: {
  feedEntries: Array<{ id: string; title: string }>;
  voyageBehavior?: () => void;
}) {
  const voyageCalls: Array<{ input: string[] }> = [];

  return {
    voyageCalls,
    impl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      const method = init?.method ?? "GET";

      if (url.includes("a.test/feed")) {
        if (method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { ETag: `"v1-${opts.feedEntries.length}"` },
          });
        }
        return new Response(atomBody(opts.feedEntries), {
          status: 200,
          headers: { "Content-Type": "application/atom+xml" },
        });
      }

      if (url.includes("voyageai.com")) {
        if (opts.voyageBehavior) opts.voyageBehavior();
        const body = JSON.parse(String(init?.body ?? "{}"));
        voyageCalls.push({ input: body.input });
        const data = body.input.map((_: string, i: number) => ({
          embedding: [i, i, i],
          index: i,
        }));
        return new Response(JSON.stringify({ data, usage: { total_tokens: 1 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(`unexpected ${method} ${url}`, { status: 404 });
    }) as unknown as typeof fetch,
  };
}

/**
 * Fake VectorizeIndex. `upsertBehavior` lets tests force the binding to throw
 * on a given invocation — that's how we drive the "embed step retries on
 * Vectorize failure" case without touching real infra.
 */
function mkVectorize(opts: { upsertBehavior?: () => void } = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const upserted: any[][] = [];
  const index = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async upsert(v: any[]) {
      if (opts.upsertBehavior) opts.upsertBehavior();
      upserted.push(v);
      return { mutationId: `m${upserted.length}` };
    },
    async deleteByIds(_ids: string[]) {
      return { mutationId: "del" };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { index, upserted };
}

function mkEnv(overrides: Record<string, unknown> = {}): PollAndFetchWorkflowEnv {
  return {
    DB: {},
    CRON_ENABLED: "true",
    EMBEDDING_PROVIDER: "voyage",
    VOYAGE_API_KEY: { get: async () => "test-voyage-key" },
    LATEST_CACHE: { delete: async () => {} },
    INVALIDATION_ENABLED: "true",
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function runWorkflow(env: PollAndFetchWorkflowEnv, sourceId = "src_a1") {
  const { step, records } = mkFakeStep();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as any;
  const wf = new PollAndFetchWorkflow(ctx, env);
  try {
    await wf.run(
      {
        payload: { sourceId, scheduledTime: Date.now() },
        instanceId: "test",
        timestamp: new Date(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      step as any,
    );
  } catch (err) {
    return { records, thrown: err };
  }
  return { records, thrown: undefined };
}

// ── Tests ──

describe("PollAndFetchWorkflow", () => {
  let realFetch: typeof globalThis.fetch;
  let invalidationCalls: Array<{ nReleases: number; sourceId: string }>;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    invalidationCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** LATEST_CACHE stub that records every .delete() call the workflow makes. */
  function mkCacheRecorder() {
    return {
      delete: async (_key: string) => {
        invalidationCalls.push({ nReleases: -1, sourceId: "" });
      },
    };
  }

  it("happy path: poll → fetch → insert → embed → invalidate", async () => {
    const db = mkDb();
    const feed = mkFetch({
      feedEntries: [
        { id: "https://a.test/v1", title: "v1" },
        { id: "https://a.test/v2", title: "v2" },
      ],
    });
    globalThis.fetch = feed.impl;
    const vec = mkVectorize();
    const env = mkEnv({
      _drizzleOverride: db,
      RELEASES_INDEX: vec.index,
      LATEST_CACHE: mkCacheRecorder(),
    });

    const { records, thrown } = await runWorkflow(env);
    expect(thrown).toBeUndefined();

    const stepNames = records.map((r) => r.name);
    expect(stepNames).toContain("load-source");
    expect(stepNames).toContain("poll-head-check");
    expect(stepNames).toContain("fetch-and-persist");
    expect(stepNames).toContain("embed-releases");
    expect(stepNames).toContain("invalidate-latest-cache");
    for (const r of records) expect(r.ok).toBe(true);

    // Two releases persisted
    expect(db.select().from(releases).all()).toHaveLength(2);

    // Voyage called once, Vectorize upserted once
    expect(feed.voyageCalls).toHaveLength(1);
    expect(vec.upserted).toHaveLength(1);
    expect(vec.upserted[0]).toHaveLength(2);

    // Latest-cache invalidation fired exactly once for this source
    expect(invalidationCalls).toHaveLength(1);
  });

  it("embed-releases retries on transient Vectorize failure and recovers", async () => {
    const db = mkDb();
    const feed = mkFetch({
      feedEntries: [{ id: "https://a.test/v1", title: "v1" }],
    });
    globalThis.fetch = feed.impl;

    let attempts = 0;
    const vec = mkVectorize({
      upsertBehavior: () => {
        attempts++;
        if (attempts < 3) throw new Error("vectorize 429");
      },
    });
    const env = mkEnv({
      _drizzleOverride: db,
      RELEASES_INDEX: vec.index,
      LATEST_CACHE: mkCacheRecorder(),
    });

    const { records, thrown } = await runWorkflow(env);
    expect(thrown).toBeUndefined();

    const embedStep = records.find((r) => r.name === "embed-releases");
    expect(embedStep?.ok).toBe(true);
    expect(embedStep?.attempts).toBe(3);

    // Vectorize upsert succeeded on the 3rd try, so invalidation still runs.
    expect(invalidationCalls).toHaveLength(1);
  });

  it("embed-releases exhausts retries and bubbles the failure", async () => {
    const db = mkDb();
    const feed = mkFetch({
      feedEntries: [{ id: "https://a.test/v1", title: "v1" }],
    });
    globalThis.fetch = feed.impl;

    const vec = mkVectorize({
      upsertBehavior: () => {
        throw new Error("vectorize persistent 5xx");
      },
    });
    const env = mkEnv({
      _drizzleOverride: db,
      RELEASES_INDEX: vec.index,
      LATEST_CACHE: mkCacheRecorder(),
    });

    const { records, thrown } = await runWorkflow(env);
    expect(thrown).toBeInstanceOf(Error);

    const embedStep = records.find((r) => r.name === "embed-releases");
    expect(embedStep?.ok).toBe(false);
    // Retry policy is limit 5 → 6 total attempts.
    expect(embedStep?.attempts).toBe(6);

    // Insert succeeded and retried idempotently (still exactly 1 row).
    expect(db.select().from(releases).all()).toHaveLength(1);

    // Invalidation did NOT run because the workflow exited via embed failure.
    expect(invalidationCalls).toHaveLength(0);
  });

  it("source not found: NonRetryableError, no retries", async () => {
    const db = mkDb();
    const env = mkEnv({ _drizzleOverride: db });
    const { records, thrown } = await runWorkflow(env, "src_nonexistent");
    const load = records.find((r) => r.name === "load-source");
    expect(load?.ok).toBe(false);
    expect(load?.attempts).toBe(1);
    expect(thrown).toBeInstanceOf(Error);
  });

  it("CRON_ENABLED=false: short-circuits before load-source", async () => {
    const db = mkDb();
    const env = mkEnv({ _drizzleOverride: db, CRON_ENABLED: "false" });
    const { records } = await runWorkflow(env);
    expect(records).toHaveLength(0);
    expect(db.select().from(fetchLog).all()).toHaveLength(0);
    expect(db.select().from(releases).all()).toHaveLength(0);
  });

  it("no change: pollOne returns changed=false → skips downstream", async () => {
    // Scrape source without a feedUrl → pollOne returns changed=false
    // without making any upstream request.
    const db = mkDb();
    db.update(sources)
      .set({ metadata: JSON.stringify({}) })
      .where(eq(sources.id, "src_a1"))
      .run();
    const env = mkEnv({ _drizzleOverride: db });
    const { records } = await runWorkflow(env);
    const stepNames = records.map((r) => r.name);
    expect(stepNames).toContain("poll-head-check");
    expect(stepNames).not.toContain("fetch-and-persist");
    expect(stepNames).not.toContain("embed-releases");
    expect(invalidationCalls).toHaveLength(0);
  });

  it("empty feed: fetch succeeds but skips embed + invalidation", async () => {
    const db = mkDb();
    const feed = mkFetch({ feedEntries: [] });
    globalThis.fetch = feed.impl;
    const vec = mkVectorize();
    const env = mkEnv({
      _drizzleOverride: db,
      RELEASES_INDEX: vec.index,
      LATEST_CACHE: mkCacheRecorder(),
    });

    const { records } = await runWorkflow(env);
    const stepNames = records.map((r) => r.name);
    expect(stepNames).toContain("fetch-and-persist");
    expect(stepNames).not.toContain("embed-releases");
    expect(stepNames).not.toContain("invalidate-latest-cache");
    expect(invalidationCalls).toHaveLength(0);
  });
});
