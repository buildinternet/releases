import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import {
  sources,
  organizations,
  releases,
  fetchLog,
  knowledgePages,
} from "@buildinternet/releases-core/schema";
import { applyMigrations } from "../db-helper";
import {
  PollAndFetchWorkflow,
  generateContentForReleases,
} from "../../workers/api/src/workflows/poll-and-fetch";
import type { PollAndFetchWorkflowEnv } from "../../workers/api/src/workflows/poll-and-fetch";
import { mkFakeStep, mkFetch, mkVectorize } from "./_workflow-test-helpers";
import { CACHEABLE_DEFAULT_SHAPES } from "../../workers/api/src/lib/latest-cache";
import { purgeKeysForHomepageTicker } from "../../workers/api/src/graphql/persisted";

// One logical invalidation deletes one KV key per cacheable REST shape plus
// one per persisted-cached GraphQL hash (today: just the homepage ticker).
const CACHE_DELETES_PER_INVALIDATION =
  CACHEABLE_DEFAULT_SHAPES.length + purgeKeysForHomepageTicker().length;

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
    // (one delete per cacheable shape).
    expect(invalidationCalls).toHaveLength(CACHE_DELETES_PER_INVALIDATION);
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
    expect(invalidationCalls).toHaveLength(CACHE_DELETES_PER_INVALIDATION);
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

  it("source not found: ends cleanly, no retries, no failure row", async () => {
    const db = mkDb();
    const env = mkEnv({ _drizzleOverride: db });
    const { records, thrown } = await runWorkflow(env, "src_nonexistent");
    const load = records.find((r) => r.name === "load-source");
    expect(load?.ok).toBe(false);
    expect(load?.attempts).toBe(1);
    // Deleted-source race ends in `Completed` rather than `Errored` so the
    // Workflows control plane doesn't surface a synthetic terminal failure
    // (see issue #713). The catch block matches the sentinel and returns.
    expect(thrown).toBeUndefined();
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

  it("scrape-no-feed: pollOne flags changed via quirk → workflow defers to sweep, no fetch", async () => {
    // Repro for the prod alert pattern: a scrape source with no feedUrl is
    // admitted to the workflow when SCRAPE_CHANGE_DETECT_ENABLED=true. pollOne's
    // quirks-driven detector flags it as changed; calling fetchOne would then
    // fail with "Missing feedUrl or feedType". The workflow must short-circuit
    // and let the scrape-agent sweep cron drain it via `changeDetectedAt`.
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    applyMigrations(sqlite);
    db.insert(organizations)
      .values({ id: "org_a", name: "Acme", slug: "acme", category: "cloud" })
      .run();
    db.insert(sources)
      .values({
        id: "src_scrape",
        orgId: "org_a",
        slug: "acme-scrape",
        name: "Acme Scrape",
        url: "https://a.test/changelog",
        type: "scrape",
        metadata: JSON.stringify({}), // no feedUrl/feedType
      })
      .run();
    // Playbook with an etag-detector quirk for this source slug.
    db.insert(knowledgePages)
      .values({
        scope: "playbook",
        orgId: "org_a",
        content: "",
        notes: [
          "---",
          "fetchQuirks:",
          "  acme-scrape:",
          "    changeDetector: etag",
          "    rationale: testing",
          "---",
          "",
        ].join("\n"),
      })
      .run();

    // HEAD on page URL returns a fresh ETag → detector reports changed.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("a.test/changelog") && (init?.method ?? "GET") === "HEAD") {
        return new Response(null, { status: 200, headers: { ETag: '"v2"' } });
      }
      return new Response(`unexpected ${init?.method ?? "GET"} ${url}`, { status: 404 });
    }) as unknown as typeof fetch;

    const env = mkEnv({
      _drizzleOverride: db,
      SCRAPE_CHANGE_DETECT_ENABLED: "true",
      LATEST_CACHE: mkCacheRecorder(),
    });

    const { records, thrown } = await runWorkflow(env, "src_scrape");
    expect(thrown).toBeUndefined();

    const stepNames = records.map((r) => r.name);
    expect(stepNames).toContain("poll-head-check");
    // Critical: must NOT run the feed fetch path.
    expect(stepNames).not.toContain("fetch-and-persist");
    expect(stepNames).not.toContain("embed-releases");
    expect(invalidationCalls).toHaveLength(0);

    // pollOne wrote `changeDetectedAt` so the sweep cron can pick it up.
    const [row] = db.select().from(sources).where(eq(sources.id, "src_scrape")).all();
    expect(row.changeDetectedAt).not.toBeNull();
    expect(db.select().from(fetchLog).all()).toHaveLength(0);
  });

  // ── generate-content step (Phase 2) ──

  it("generate-content: opted-in org populates content_* columns", async () => {
    const db = mkDb();
    db.update(organizations)
      .set({ autoGenerateContent: true })
      .where(eq(organizations.id, "org_a"))
      .run();
    const feed = mkFetch({
      feedEntries: [{ id: "https://a.test/v1", title: "v1" }],
      anthropicBehavior: () => ({
        title: "Acme One v1 fixes worktree bug",
        titleShort: "Worktree no longer drops commits",
        summary: "Fixed a worktree bug that was dropping unpushed commits.",
      }),
    });
    globalThis.fetch = feed.impl;
    const env = mkEnv({
      _drizzleOverride: db,
      RELEASES_INDEX: mkVectorize().index,
      LATEST_CACHE: mkCacheRecorder(),
      ANTHROPIC_API_KEY: { get: async () => "test-anthropic-key" },
    });

    const { records, thrown } = await runWorkflow(env);
    expect(thrown).toBeUndefined();

    const stepNames = records.map((r) => r.name);
    expect(stepNames).toContain("generate-content");
    const generateStep = records.find((r) => r.name === "generate-content");
    expect(generateStep?.ok).toBe(true);
    expect(feed.anthropicCalls).toHaveLength(1);

    const [row] = db.select().from(releases).all();
    expect(row.contentTitle).toBe("Acme One v1 fixes worktree bug");
    expect(row.contentTitleShort).toBe("Worktree no longer drops commits");
    expect(row.contentSummary).toBe("Fixed a worktree bug that was dropping unpushed commits.");
  });

  it("generate-content: opted-out org skips Anthropic call entirely", async () => {
    const db = mkDb();
    // Org default `autoGenerateContent = false` (set by mkDb).
    const feed = mkFetch({
      feedEntries: [{ id: "https://a.test/v1", title: "v1" }],
      // anthropicBehavior intentionally omitted — any call would 500.
    });
    globalThis.fetch = feed.impl;
    const env = mkEnv({
      _drizzleOverride: db,
      RELEASES_INDEX: mkVectorize().index,
      LATEST_CACHE: mkCacheRecorder(),
      ANTHROPIC_API_KEY: { get: async () => "test-anthropic-key" },
    });

    const { records, thrown } = await runWorkflow(env);
    expect(thrown).toBeUndefined();

    const generateStep = records.find((r) => r.name === "generate-content");
    expect(generateStep?.ok).toBe(true);
    expect(feed.anthropicCalls).toHaveLength(0);

    const [row] = db.select().from(releases).all();
    expect(row.contentTitle).toBeNull();
    expect(row.contentTitleShort).toBeNull();
    expect(row.contentSummary).toBeNull();
  });

  it("generate-content: per-row Anthropic failure is logged + skipped, step still ok", async () => {
    const db = mkDb();
    db.update(organizations)
      .set({ autoGenerateContent: true })
      .where(eq(organizations.id, "org_a"))
      .run();
    const feed = mkFetch({
      feedEntries: [{ id: "https://a.test/v1", title: "v1" }],
      anthropicBehavior: () => {
        throw new Error("upstream rate limit");
      },
    });
    globalThis.fetch = feed.impl;
    const env = mkEnv({
      _drizzleOverride: db,
      RELEASES_INDEX: mkVectorize().index,
      LATEST_CACHE: mkCacheRecorder(),
      ANTHROPIC_API_KEY: { get: async () => "test-anthropic-key" },
    });

    const { records, thrown } = await runWorkflow(env);
    expect(thrown).toBeUndefined();

    const generateStep = records.find((r) => r.name === "generate-content");
    expect(generateStep?.ok).toBe(true);

    // Row stays NULL — failure didn't write a placeholder.
    const [row] = db.select().from(releases).all();
    expect(row.contentTitle).toBeNull();
    expect(row.contentTitleShort).toBeNull();
    expect(row.contentSummary).toBeNull();

    // Embed still ran — generate-content failures don't gate downstream steps.
    expect(records.find((r) => r.name === "embed-releases")?.ok).toBe(true);
  });

  it("generate-content: missing ANTHROPIC_API_KEY is a clean no-op", async () => {
    const db = mkDb();
    db.update(organizations)
      .set({ autoGenerateContent: true })
      .where(eq(organizations.id, "org_a"))
      .run();
    const feed = mkFetch({
      feedEntries: [{ id: "https://a.test/v1", title: "v1" }],
    });
    globalThis.fetch = feed.impl;
    const env = mkEnv({
      _drizzleOverride: db,
      RELEASES_INDEX: mkVectorize().index,
      LATEST_CACHE: mkCacheRecorder(),
      // ANTHROPIC_API_KEY intentionally omitted.
    });

    const { records, thrown } = await runWorkflow(env);
    expect(thrown).toBeUndefined();

    const generateStep = records.find((r) => r.name === "generate-content");
    expect(generateStep?.ok).toBe(true);
    expect(feed.anthropicCalls).toHaveLength(0);
  });

  it("generate-content: IS NULL guard prevents overwriting an already-populated row", async () => {
    const db = mkDb();
    db.update(organizations)
      .set({ autoGenerateContent: true })
      .where(eq(organizations.id, "org_a"))
      .run();

    // Pre-insert a release with content_title_short already populated, simulating
    // a row the script (or a prior workflow run) already summarized.
    const releaseId = "rel_pretest";
    db.insert(releases)
      .values({
        id: releaseId,
        sourceId: "src_a1",
        title: "v1",
        content: "Real release body that would otherwise pass isEmptyContent.",
        contentTitle: "preset title",
        contentTitleShort: "preset short",
        contentSummary: "preset summary",
      })
      .run();

    const feed = mkFetch({
      anthropicBehavior: () => ({
        title: "regenerated title",
        titleShort: "regenerated short",
        summary: "regenerated summary",
      }),
    });
    globalThis.fetch = feed.impl;
    const env = mkEnv({
      _drizzleOverride: db,
      ANTHROPIC_API_KEY: { get: async () => "test-anthropic-key" },
    });

    const [source] = db.select().from(sources).where(eq(sources.id, "src_a1")).all();
    await generateContentForReleases(db, env, source, [releaseId]);

    // The row matched the SELECT (org is opted-in) so the model was called…
    expect(feed.anthropicCalls).toHaveLength(1);
    // …but the IS NULL guard on the UPDATE prevents the model output from
    // overwriting the preset values.
    const [row] = db.select().from(releases).where(eq(releases.id, releaseId)).all();
    expect(row.contentTitleShort).toBe("preset short");
    expect(row.contentTitle).toBe("preset title");
    expect(row.contentSummary).toBe("preset summary");
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
