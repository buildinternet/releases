/**
 * Defense-in-depth guard: PollAndFetchWorkflow must return early (no
 * poll-head-check, no fetch-and-persist) when the loaded source has
 * `metadata.firecrawl.enabled = true`. In normal operation
 * `queryDueSources` already excludes such sources from the fan-out, but
 * if one is started manually or the exclusion regresses, the workflow
 * should not double-ingest the source.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { organizations, sources, fetchLog } from "@buildinternet/releases-core/schema";
import { applyMigrations, ensureBatchShim } from "../db-helper";
import { PollAndFetchWorkflow } from "../../workers/api/src/workflows/poll-and-fetch";
import type { PollAndFetchWorkflowEnv } from "../../workers/api/src/workflows/poll-and-fetch";
import { mkFakeStep } from "./_workflow-test-helpers";

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = ensureBatchShim(drizzle(sqlite));
  applyMigrations(sqlite);
  db.insert(organizations)
    .values({ id: "org_fc", name: "Acme FC", slug: "acme-fc", category: "cloud" })
    .run();
  db.insert(sources)
    .values({
      id: "src_fc1",
      orgId: "org_fc",
      slug: "acme-fc-changelog",
      name: "Acme FC Changelog",
      url: "https://acme.com/changelog",
      type: "scrape",
      metadata: JSON.stringify({
        feedUrl: "https://acme.com/feed.xml",
        firecrawl: { enabled: true, proxy: "auto" },
      }),
    })
    .run();
  return db;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkEnv(db: any, overrides: Record<string, unknown> = {}): PollAndFetchWorkflowEnv {
  return {
    DB: {},
    CRON_ENABLED: "true",
    _drizzleOverride: db,
    LATEST_CACHE: { delete: async () => {} },
    INVALIDATION_ENABLED: "false",
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function runWorkflow(env: PollAndFetchWorkflowEnv, sourceId = "src_fc1") {
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

describe("PollAndFetchWorkflow — firecrawl-owned skip guard", () => {
  it("returns early after load-source without running poll-head-check or fetch-and-persist", async () => {
    const db = mkDb();
    const env = mkEnv(db);

    const { records, thrown } = await runWorkflow(env);

    // Workflow exits cleanly (no thrown error).
    expect(thrown).toBeUndefined();

    const stepNames = records.map((r) => r.name);

    // load-source must run (that's how we detect firecrawl ownership).
    expect(stepNames).toContain("load-source");

    // The poll and fetch steps must NOT have run.
    expect(stepNames).not.toContain("poll-head-check");
    expect(stepNames).not.toContain("fetch-and-persist");

    // No fetch_log row should be written for the source.
    const logs = db.select().from(fetchLog).all();
    expect(logs).toHaveLength(0);
  });
});
