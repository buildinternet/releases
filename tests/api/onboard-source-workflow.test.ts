/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sources, organizations, knowledgePages } from "@buildinternet/releases-core/schema";
import { applyMigrations } from "../db-helper";
import { workflowFailures } from "../../workers/api/src/db/schema-workflow-failures";
import { OnboardSourceWorkflow } from "../../workers/api/src/workflows/onboard-source";
import type { OnboardSourceWorkflowEnv } from "../../workers/api/src/workflows/onboard-source";
import { mkFakeStep, mkFetch, mkVectorize } from "./_workflow-test-helpers";

function mkDb(opts: { type?: "feed" | "scrape" | "agent"; feedUrl?: string } = {}) {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  db.insert(organizations)
    .values({ id: "org_a", name: "Acme", slug: "acme", category: "cloud" })
    .run();
  const meta: Record<string, unknown> = {};
  if (opts.feedUrl) {
    meta.feedUrl = opts.feedUrl;
    meta.feedType = "atom";
  }
  db.insert(sources)
    .values({
      id: "src_a1",
      orgId: "org_a",
      slug: "acme-one",
      name: "Acme One",
      url: opts.feedUrl ?? "https://a.test/blog",
      type: opts.type ?? "feed",
      metadata: JSON.stringify(meta),
    })
    .run();
  return { db, sqlite };
}

function mkEnv(overrides: Record<string, unknown> = {}): OnboardSourceWorkflowEnv {
  return {
    DB: {},
    EMBEDDING_PROVIDER: "voyage",
    VOYAGE_API_KEY: { get: async () => "test-voyage-key" },
    LATEST_CACHE: { delete: async () => {} },
    INVALIDATION_ENABLED: "true",
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function runWorkflow(
  env: OnboardSourceWorkflowEnv,
  payload: { sourceId?: string; skipBackfill?: boolean } = {},
) {
  const { step, records } = mkFakeStep();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as any;
  const wf = new OnboardSourceWorkflow(ctx, env);
  try {
    await wf.run(
      {
        payload: { sourceId: payload.sourceId ?? "src_a1", skipBackfill: payload.skipBackfill },
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

describe("OnboardSourceWorkflow", () => {
  let realFetch: typeof globalThis.fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("happy path (feed): playbook → embed → backfill", async () => {
    const { db } = mkDb({ type: "feed", feedUrl: "https://a.test/feed" });
    const feed = mkFetch({ feedEntries: [{ id: "https://a.test/v1", title: "v1" }] });
    globalThis.fetch = feed.impl;
    const entities = mkVectorize();
    const releasesIdx = mkVectorize();
    const env = mkEnv({
      _drizzleOverride: db,
      ENTITIES_INDEX: entities.index,
      RELEASES_INDEX: releasesIdx.index,
    });

    const { records, thrown } = await runWorkflow(env);
    expect(thrown).toBeUndefined();

    const stepNames = records.map((r) => r.name);
    expect(stepNames).toEqual([
      "load-source",
      "regenerate-playbook",
      "embed-source",
      "backfill-fetch",
      "embed-releases",
      "invalidate-latest-cache",
    ]);
    for (const r of records) expect(r.ok).toBe(true);

    const [playbook] = db.select().from(knowledgePages).all();
    expect(playbook?.scope).toBe("playbook");

    // Both ENTITIES_INDEX (entity embed) and RELEASES_INDEX (release embed) hit once each.
    expect(entities.upserted).toHaveLength(1);
    expect(releasesIdx.upserted).toHaveLength(1);

    expect(db.select().from(workflowFailures).all()).toHaveLength(0);
  });

  it("manual mode skips backfill but still runs playbook + embed", async () => {
    const { db } = mkDb({ type: "feed", feedUrl: "https://a.test/feed" });
    const feed = mkFetch({ feedEntries: [{ id: "https://a.test/v1", title: "v1" }] });
    globalThis.fetch = feed.impl;
    const entities = mkVectorize();
    const env = mkEnv({
      _drizzleOverride: db,
      ENTITIES_INDEX: entities.index,
    });

    const { records, thrown } = await runWorkflow(env, { skipBackfill: true });
    expect(thrown).toBeUndefined();

    const stepNames = records.map((r) => r.name);
    expect(stepNames).toEqual(["load-source", "regenerate-playbook", "embed-source"]);
    expect(stepNames).not.toContain("backfill-fetch");

    // Voyage was hit by the embed step but not by any release-embed downstream.
    expect(entities.upserted).toHaveLength(1);
  });

  it("scrape-no-feed source defers backfill to the daily sweep", async () => {
    const { db } = mkDb({ type: "scrape" });
    globalThis.fetch = mkFetch({}).impl;
    const entities = mkVectorize();
    const env = mkEnv({ _drizzleOverride: db, ENTITIES_INDEX: entities.index });

    const { records, thrown } = await runWorkflow(env);
    expect(thrown).toBeUndefined();

    const stepNames = records.map((r) => r.name);
    expect(stepNames).toEqual(["load-source", "regenerate-playbook", "embed-source"]);
    expect(stepNames).not.toContain("backfill-fetch");
  });

  it("source deleted between dispatch and run: NonRetryableError, no failure row", async () => {
    const { db } = mkDb({ type: "feed", feedUrl: "https://a.test/feed" });
    globalThis.fetch = mkFetch({}).impl;
    const env = mkEnv({ _drizzleOverride: db, ENTITIES_INDEX: mkVectorize().index });

    const { records, thrown } = await runWorkflow(env, { sourceId: "src_missing" });
    expect(thrown).toBeDefined();
    expect((thrown as Error).constructor.name).toBe("NonRetryableError");

    const loadStep = records.find((r) => r.name === "load-source");
    expect(loadStep?.ok).toBe(false);
    expect(loadStep?.attempts).toBe(1);

    // Deleted-source race must not be recorded as a workflow failure — the
    // catch handler matches the sentinel verbatim.
    expect(db.select().from(workflowFailures).all()).toHaveLength(0);
  });

  it("embed-source retries on transient Vectorize failure and recovers", async () => {
    const { db } = mkDb({ type: "scrape" });
    let attempts = 0;
    const entities = mkVectorize({
      upsertBehavior: () => {
        attempts++;
        if (attempts < 3) throw new Error("vectorize 429");
      },
    });
    // No fetch needed — scrape-no-feed source short-circuits before backfill.
    const feed = mkFetch({});
    globalThis.fetch = feed.impl;
    const env = mkEnv({ _drizzleOverride: db, ENTITIES_INDEX: entities.index });

    const { records, thrown } = await runWorkflow(env);
    expect(thrown).toBeUndefined();
    const embedStep = records.find((r) => r.name === "embed-source");
    expect(embedStep?.ok).toBe(true);
    expect(embedStep?.attempts).toBe(3);
    expect(entities.upserted).toHaveLength(1);
  });

  it("records workflow_failures row when a step exhausts retries", async () => {
    const { db } = mkDb({ type: "scrape" });
    const entities = mkVectorize({
      upsertBehavior: () => {
        throw new Error("vectorize down");
      },
    });
    const feed = mkFetch({});
    globalThis.fetch = feed.impl;
    const env = mkEnv({ _drizzleOverride: db, ENTITIES_INDEX: entities.index });

    const { thrown } = await runWorkflow(env);
    expect(thrown).toBeDefined();

    const rows = db.select().from(workflowFailures).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceId).toBe("src_a1");
    expect(rows[0]?.stepName).toBe("embed-source");
    expect(rows[0]?.id.startsWith("wf-fail-onboard-")).toBe(true);
  });

  it("on-demand orgs skip playbook regen but still embed", async () => {
    const { db, sqlite } = mkDb({ type: "scrape" });
    sqlite.run("UPDATE organizations SET discovery = 'on_demand' WHERE id = 'org_a'");
    globalThis.fetch = mkFetch({}).impl;
    const entities = mkVectorize();
    const env = mkEnv({ _drizzleOverride: db, ENTITIES_INDEX: entities.index });

    const { records, thrown } = await runWorkflow(env);
    expect(thrown).toBeUndefined();

    // The step still runs (it's gated by source.orgId, not by org.discovery),
    // but the helper short-circuits internally → no playbook row written.
    expect(records.find((r) => r.name === "regenerate-playbook")?.ok).toBe(true);
    expect(db.select().from(knowledgePages).all()).toHaveLength(0);

    // Embed still runs.
    expect(entities.upserted).toHaveLength(1);
  });

  it("orphan source (no orgId) skips playbook step", async () => {
    const { db, sqlite } = mkDb({ type: "scrape" });
    sqlite.run("UPDATE sources SET org_id = NULL WHERE id = 'src_a1'");
    globalThis.fetch = mkFetch({}).impl;
    const entities = mkVectorize();
    const env = mkEnv({ _drizzleOverride: db, ENTITIES_INDEX: entities.index });

    const { records, thrown } = await runWorkflow(env);
    expect(thrown).toBeUndefined();
    const stepNames = records.map((r) => r.name);
    expect(stepNames).toEqual(["load-source", "embed-source"]);
  });
});
