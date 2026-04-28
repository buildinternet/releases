import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { desc, sql } from "drizzle-orm";
import { applyMigrations } from "../db-helper";
import { sources, organizations, fetchLog } from "@buildinternet/releases-core/schema";
import { cronRuns } from "../../workers/api/src/db/schema-cron";
import {
  ScrapeAgentSweepWorkflow,
  type ScrapeAgentSweepWorkflowEnv,
} from "../../workers/api/src/workflows/scrape-agent-sweep";

/**
 * Fake WorkflowStep. For `step.do`, runs the callback inline. Honors
 * `config.retries.limit` so tests can verify retry behavior without
 * waiting real backoff delays. Records every step name + outcome.
 */
type StepRecord = {
  name: string;
  attempts: number;
  ok: boolean;
  error?: string;
};

function mkFakeStep() {
  const records: StepRecord[] = [];
  const step = {
    async do<T>(name: string, a: unknown, b?: unknown): Promise<T> {
      const config = typeof a === "object" && a !== null && !("call" in a) ? a : undefined;
      const cb = (b ?? a) as () => Promise<T>;
      const retryLimit =
        (config as { retries?: { limit: number } } | undefined)?.retries?.limit ?? 0;
      let attempts = 0;
      let lastError: unknown;
      // Total attempts = initial + retryLimit (e.g. limit:3 → up to 4 attempts).
      // Sequential is intentional — we're simulating retry-with-backoff.
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
    async sleep(_name: string, _duration: unknown) {
      /* no-op */
    },
    async sleepUntil(_name: string, _timestamp: unknown) {
      /* no-op */
    },
    async waitForEvent<T>(_name: string, _opts: unknown): Promise<T> {
      throw new Error("waitForEvent not expected in this workflow");
    },
  };
  return { step, records };
}

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  db.insert(organizations)
    .values([
      { id: "org_a", name: "Org A", slug: "a", category: "developer-tools" },
      { id: "org_b", name: "Org B", slug: "b", category: "developer-tools" },
      { id: "org_c", name: "Org C", slug: "c", category: "developer-tools" },
    ])
    .run();
  db.insert(sources)
    .values([
      {
        id: "src_1",
        name: "S1",
        slug: "s-1",
        type: "scrape",
        url: "https://a.com/c",
        orgId: "org_a",
        changeDetectedAt: "2026-04-18T00:00:00Z",
        metadata: "{}",
      },
      {
        id: "src_2",
        name: "S2",
        slug: "s-2",
        type: "scrape",
        url: "https://b.com/c",
        orgId: "org_b",
        changeDetectedAt: "2026-04-18T00:01:00Z",
        metadata: "{}",
      },
      {
        id: "src_3",
        name: "S3",
        slug: "s-3",
        type: "scrape",
        url: "https://c.com/c",
        orgId: "org_c",
        changeDetectedAt: "2026-04-18T00:02:00Z",
        metadata: "{}",
      },
    ])
    .run();
  return db;
}

function mkEnv(overrides: Partial<ScrapeAgentSweepWorkflowEnv> = {}) {
  return {
    DB: {} as any,
    CRON_ENABLED: "true",
    SCRAPE_AGENT_CRON_ENABLED: "true",
    SCRAPE_AGENT_MAX_SESSIONS: "20",
    DISCOVERY_WORKER: {
      fetch: async () => new Response(JSON.stringify({ sessionId: "ma-auto" }), { status: 202 }),
    } as ScrapeAgentSweepWorkflowEnv["DISCOVERY_WORKER"],
    RELEASED_API_KEY: { get: async () => "test-api-key" },
    ANTHROPIC_API_KEY: { get: async () => "test-anthropic-key" },
    ...overrides,
  } as ScrapeAgentSweepWorkflowEnv;
}

async function runWorkflow(env: ScrapeAgentSweepWorkflowEnv) {
  const { step, records } = mkFakeStep();
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as any;
  const wf = new ScrapeAgentSweepWorkflow(ctx, env);
  await wf.run(
    { payload: { scheduledTime: Date.now() }, instanceId: "test", timestamp: new Date() } as any,
    step as any,
  );
  return records;
}

describe("ScrapeAgentSweepWorkflow (E2E)", () => {
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    // Default: Anthropic preflight succeeds.
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("happy path: 3 orgs -> 3 dispatches -> status done", async () => {
    const db = mkDb();
    let dispatchCount = 0;
    const env = mkEnv({
      DISCOVERY_WORKER: {
        fetch: async () => {
          dispatchCount++;
          return new Response(JSON.stringify({ sessionId: `ma-${dispatchCount}` }), {
            status: 202,
          });
        },
      } as ScrapeAgentSweepWorkflowEnv["DISCOVERY_WORKER"],
      _drizzleOverride: db,
    });
    const records = await runWorkflow(env);
    expect(dispatchCount).toBe(3);
    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    expect(run.status).toBe("done");
    expect(run.dispatched).toBe(3);
    expect(run.candidates).toBe(3);
    // Step boundaries observed
    const stepNames = records.map((r) => r.name);
    expect(stepNames).toContain("init-run");
    expect(stepNames).toContain("preflight");
    expect(stepNames).toContain("query-candidates");
    expect(stepNames).toContain("dispatch-a");
    expect(stepNames).toContain("dispatch-b");
    expect(stepNames).toContain("dispatch-c");
    expect(stepNames).toContain("finalize-done");
    // Result-aggregation pipeline runs after dispatch.
    expect(stepNames).toContain("aggregate-results");
    expect(stepNames).toContain("send-report");
  });

  it("aggregates fetch_log rows for dispatched sessions before sending report", async () => {
    const db = mkDb();
    let dispatchCount = 0;
    const env = mkEnv({
      DISCOVERY_WORKER: {
        fetch: async () => {
          dispatchCount++;
          return new Response(JSON.stringify({ sessionId: `ma-${dispatchCount}` }), {
            status: 202,
          });
        },
      } as ScrapeAgentSweepWorkflowEnv["DISCOVERY_WORKER"],
      _drizzleOverride: db,
    });
    // Seed fetch_log with rows for the session IDs dispatch will mint
    // (ma-1, ma-2, ma-3 in dispatch order: orgs a, b, c).
    db.insert(fetchLog)
      .values([
        {
          sourceId: "src_1",
          sessionId: "ma-1",
          releasesFound: 5,
          releasesInserted: 3,
          status: "success",
        },
        {
          sourceId: "src_2",
          sessionId: "ma-2",
          releasesFound: 2,
          releasesInserted: 2,
          status: "success",
        },
        // ma-3 has no fetch_log rows → reported as still running.
      ])
      .run();
    const records = await runWorkflow(env);
    const aggregateStep = records.find((r) => r.name === "aggregate-results");
    expect(aggregateStep?.ok).toBe(true);
    expect(records.find((r) => r.name === "send-report")?.ok).toBe(true);
  });

  it("send-report still runs when top-searches retries exhaust", async () => {
    const db = mkDb();
    const env = mkEnv({
      DISCOVERY_WORKER: {
        fetch: async () => new Response(JSON.stringify({ sessionId: "ma-x" }), { status: 202 }),
      } as ScrapeAgentSweepWorkflowEnv["DISCOVERY_WORKER"],
      _drizzleOverride: db,
    });
    // Drop the search_queries table out from under the helper so it always throws.
    db.run(sql`DROP TABLE search_queries`);
    const records = await runWorkflow(env);
    const topSearchesStep = records.find((r) => r.name === "top-searches");
    expect(topSearchesStep?.ok).toBe(false);
    // The digest is non-blocking — the operator still gets the daily email.
    expect(records.find((r) => r.name === "send-report")?.ok).toBe(true);
  });

  it("skips settle + aggregate steps when no sessions were dispatched", async () => {
    const db = mkDb();
    // All dispatches fail with non-retryable 401 → zero successful sessions.
    const env = mkEnv({
      DISCOVERY_WORKER: {
        fetch: async () => new Response("{}", { status: 401 }),
      } as ScrapeAgentSweepWorkflowEnv["DISCOVERY_WORKER"],
      _drizzleOverride: db,
    });
    const records = await runWorkflow(env);
    const stepNames = records.map((r) => r.name);
    expect(stepNames).not.toContain("aggregate-results");
    // send-report still runs so the operator hears about the dispatch_failed run.
    expect(stepNames).toContain("send-report");
  });

  it("pre-flight auth failure: aborts with no dispatches", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
      })) as unknown as typeof fetch;
    const db = mkDb();
    let dispatchCount = 0;
    const env = mkEnv({
      DISCOVERY_WORKER: {
        fetch: async () => {
          dispatchCount++;
          return new Response("{}", { status: 202 });
        },
      } as ScrapeAgentSweepWorkflowEnv["DISCOVERY_WORKER"],
      _drizzleOverride: db,
    });
    const records = await runWorkflow(env);
    expect(dispatchCount).toBe(0);
    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    expect(run.status).toBe("aborted");
    expect(run.abortReason).toBe("anthropic_auth");
    expect(records.map((r) => r.name)).toContain("finalize-aborted");
    expect(records.map((r) => r.name)).not.toContain("query-candidates");
  });

  it("mixed dispatch: 1 fails with a 500 -> degraded (after retries exhausted)", async () => {
    const db = mkDb();
    // First org always fails with 500; others succeed. 500 is retryable,
    // so the failing dispatch burns all retries (4 attempts total).
    const failingCalls: Record<string, number> = {};
    const env = mkEnv({
      DISCOVERY_WORKER: {
        fetch: async (_input: unknown, init?: unknown) => {
          const body = JSON.parse((init as RequestInit)?.body as string);
          const org = body.company as string;
          failingCalls[org] = (failingCalls[org] ?? 0) + 1;
          if (org === "Org A") return new Response("500 boom", { status: 500 });
          return new Response(JSON.stringify({ sessionId: `ma-${org}` }), { status: 202 });
        },
      } as ScrapeAgentSweepWorkflowEnv["DISCOVERY_WORKER"],
      _drizzleOverride: db,
    });
    const records = await runWorkflow(env);
    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    expect(run.status).toBe("degraded");
    expect(run.dispatched).toBe(2);
    expect(run.dispatchErrors).toBe(1);
    // The failing dispatch should have attempted 4 times (initial + 3 retries)
    expect(failingCalls["Org A"]).toBe(4);
    const dispatchA = records.find((r) => r.name === "dispatch-a");
    expect(dispatchA?.attempts).toBe(4);
    expect(dispatchA?.ok).toBe(false);
  });

  it("retry recovery: first attempt 500, second attempt 202 -> done with attempts=2", async () => {
    const db = mkDb();
    const callCounts: Record<string, number> = {};
    const env = mkEnv({
      DISCOVERY_WORKER: {
        fetch: async (_input: unknown, init?: unknown) => {
          const body = JSON.parse((init as RequestInit)?.body as string);
          const org = body.company as string;
          callCounts[org] = (callCounts[org] ?? 0) + 1;
          // Org A fails once then succeeds; others always succeed
          if (org === "Org A" && callCounts[org] === 1) {
            return new Response("503 transient", { status: 503 });
          }
          return new Response(JSON.stringify({ sessionId: `ma-${org}` }), { status: 202 });
        },
      } as ScrapeAgentSweepWorkflowEnv["DISCOVERY_WORKER"],
      _drizzleOverride: db,
    });
    const records = await runWorkflow(env);
    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    expect(run.status).toBe("done");
    expect(run.dispatched).toBe(3);
    expect(run.dispatchErrors).toBe(0);
    const dispatchA = records.find((r) => r.name === "dispatch-a");
    expect(dispatchA?.attempts).toBe(2);
    expect(dispatchA?.ok).toBe(true);
  });

  it("4xx is non-retryable: 401 response drops through after a single attempt", async () => {
    const db = mkDb();
    const callCounts: Record<string, number> = {};
    const env = mkEnv({
      DISCOVERY_WORKER: {
        fetch: async (_input: unknown, init?: unknown) => {
          const body = JSON.parse((init as RequestInit)?.body as string);
          const org = body.company as string;
          callCounts[org] = (callCounts[org] ?? 0) + 1;
          if (org === "Org A") return new Response("401 unauthorized", { status: 401 });
          return new Response(JSON.stringify({ sessionId: `ma-${org}` }), { status: 202 });
        },
      } as ScrapeAgentSweepWorkflowEnv["DISCOVERY_WORKER"],
      _drizzleOverride: db,
    });
    const records = await runWorkflow(env);
    expect(callCounts["Org A"]).toBe(1);
    const dispatchA = records.find((r) => r.name === "dispatch-a");
    expect(dispatchA?.attempts).toBe(1);
    expect(dispatchA?.ok).toBe(false);
    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    expect(run.status).toBe("degraded");
  });

  it("429 is retryable: rate-limit response burns retries, not NonRetryable", async () => {
    const db = mkDb();
    const callCounts: Record<string, number> = {};
    const env = mkEnv({
      DISCOVERY_WORKER: {
        fetch: async (_input: unknown, init?: unknown) => {
          const body = JSON.parse((init as RequestInit)?.body as string);
          const org = body.company as string;
          callCounts[org] = (callCounts[org] ?? 0) + 1;
          if (org === "Org A") return new Response("429 too many", { status: 429 });
          return new Response(JSON.stringify({ sessionId: `ma-${org}` }), { status: 202 });
        },
      } as ScrapeAgentSweepWorkflowEnv["DISCOVERY_WORKER"],
      _drizzleOverride: db,
    });
    await runWorkflow(env);
    expect(callCounts["Org A"]).toBe(4);
  });

  it("no candidates, no stranded: writes a healthy-quiet done row", async () => {
    // Empty DB — no sources — so queryCandidates returns 0 rows and the
    // count-stranded step also sees zero.
    const sqlite = new Database(":memory:");
    applyMigrations(sqlite);
    const db = drizzle(sqlite);
    const env = mkEnv({ _drizzleOverride: db });
    await runWorkflow(env);
    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    expect(run.status).toBe("done");
    expect(run.candidates).toBe(0);
    expect(run.notes).toBe("no flagged or stranded sources");
  });

  it("no flagged but stranded > 0: surfaces stranded count via count-stranded step", async () => {
    const sqlite = new Database(":memory:");
    applyMigrations(sqlite);
    const db = drizzle(sqlite);
    const stale = new Date(Date.now() - 96 * 3600_000).toISOString();
    db.insert(organizations)
      .values([{ id: "org_s", name: "S Org", slug: "s-org", category: "developer-tools" }])
      .run();
    db.insert(sources)
      .values([
        {
          id: "src_stale_1",
          name: "Stale 1",
          slug: "stale-1",
          type: "scrape",
          url: "https://s.com/c1",
          orgId: "org_s",
          lastFetchedAt: stale,
          metadata: "{}",
        },
        {
          id: "src_stale_2",
          name: "Stale 2",
          slug: "stale-2",
          type: "agent",
          url: "https://s.com/c2",
          orgId: "org_s",
          lastFetchedAt: stale,
          metadata: "{}",
        },
      ])
      .run();
    const env = mkEnv({ _drizzleOverride: db });
    const records = await runWorkflow(env);
    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    expect(run.status).toBe("done");
    expect(run.candidates).toBe(0);
    expect(run.notes).toBe("no flagged sources; stranded=2");
    expect(records.some((r) => r.name === "count-stranded" && r.ok)).toBe(true);
  });

  async function assertFlagDisabled(flag: keyof ScrapeAgentSweepWorkflowEnv) {
    const db = mkDb();
    let dispatchCount = 0;
    const env = mkEnv({
      [flag]: "false",
      DISCOVERY_WORKER: {
        fetch: async () => {
          dispatchCount++;
          return new Response("{}", { status: 202 });
        },
      } as ScrapeAgentSweepWorkflowEnv["DISCOVERY_WORKER"],
      _drizzleOverride: db,
    });
    await runWorkflow(env);
    expect(dispatchCount).toBe(0);
    expect(db.select().from(cronRuns).all()).toHaveLength(0);
  }

  it("CRON_ENABLED=false: short-circuits without writing a cron_runs row", () =>
    assertFlagDisabled("CRON_ENABLED"));

  it("SCRAPE_AGENT_CRON_ENABLED=false: short-circuits without writing a cron_runs row", () =>
    assertFlagDisabled("SCRAPE_AGENT_CRON_ENABLED"));

  it("cap enforcement: 21 candidates + cap=20 -> 20 dispatched, skipped=1", async () => {
    const db = mkDb();
    // mkDb seeds 3 sources across 3 orgs. Add 18 more to reach 21.
    for (let i = 0; i < 18; i++) {
      db.insert(organizations)
        .values({
          id: `org_cap_${i}`,
          name: `Cap Org ${i}`,
          slug: `cap-${i}`,
          category: "developer-tools",
        })
        .run();
      // Pre-date these so they drain first under ASC ordering.
      const ts = `2026-04-17T03:${String(i).padStart(2, "0")}:00Z`;
      db.insert(sources)
        .values({
          id: `src_cap_${i}`,
          name: `C${i}`,
          slug: `sc-${i}`,
          type: "scrape",
          url: `https://cap-${i}.com/c`,
          orgId: `org_cap_${i}`,
          changeDetectedAt: ts,
          metadata: "{}",
        })
        .run();
    }
    let dispatchCount = 0;
    const env = mkEnv({
      SCRAPE_AGENT_MAX_SESSIONS: "20",
      DISCOVERY_WORKER: {
        fetch: async () => {
          dispatchCount++;
          return new Response(JSON.stringify({ sessionId: `ma-${dispatchCount}` }), {
            status: 202,
          });
        },
      } as ScrapeAgentSweepWorkflowEnv["DISCOVERY_WORKER"],
      _drizzleOverride: db,
    });
    await runWorkflow(env);
    expect(dispatchCount).toBe(20);
    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    expect(run.candidates).toBe(20);
    expect(run.skippedOverCap).toBe(1);
  });

  it("ANTHROPIC_API_KEY missing: preflight proceeds without hitting /v1/models", async () => {
    const db = mkDb();
    let modelsCalls = 0;
    globalThis.fetch = (async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/v1/models")) modelsCalls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const env = mkEnv({
      ANTHROPIC_API_KEY: undefined,
      _drizzleOverride: db,
    });
    await runWorkflow(env);
    expect(modelsCalls).toBe(0);
    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    // 3 orgs from mkDb should still dispatch normally.
    expect(run.status).toBe("done");
    expect(run.dispatched).toBe(3);
  });

  it("DISCOVERY_WORKER missing: dispatch fails non-retryably (1 attempt)", async () => {
    const db = mkDb();
    const env = mkEnv({
      DISCOVERY_WORKER: undefined,
      _drizzleOverride: db,
    });
    const records = await runWorkflow(env);
    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    // All three dispatches fail permanently — sweep is dispatch_failed.
    expect(run.status).toBe("dispatch_failed");
    expect(run.dispatched).toBe(0);
    expect(run.dispatchErrors).toBe(3);
    // NonRetryableError from resolveDispatchEnv → single attempt each.
    for (const dispatch of records.filter((r) => r.name.startsWith("dispatch-"))) {
      expect(dispatch.attempts).toBe(1);
      expect(dispatch.ok).toBe(false);
    }
  });

  it("concurrency: fans out in chunks of CONCURRENCY=3", async () => {
    // Seed 7 orgs so chunking is visible: [3, 3, 1].
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    applyMigrations(sqlite);
    for (let i = 0; i < 7; i++) {
      db.insert(organizations)
        .values({
          id: `org_cc_${i}`,
          name: `CC ${i}`,
          slug: `cc-${i}`,
          category: "developer-tools",
        })
        .run();
      db.insert(sources)
        .values({
          id: `src_cc_${i}`,
          name: `CC${i}`,
          slug: `scc-${i}`,
          type: "scrape",
          url: `https://cc-${i}.com/c`,
          orgId: `org_cc_${i}`,
          changeDetectedAt: `2026-04-18T00:${String(i).padStart(2, "0")}:00Z`,
          metadata: "{}",
        })
        .run();
    }

    // Track concurrent inflight dispatches by having each fetch hold a
    // resolvable promise open. The max observed inflight count should be 3.
    let inflight = 0;
    let maxInflight = 0;
    const env = mkEnv({
      DISCOVERY_WORKER: {
        fetch: async () => {
          inflight++;
          maxInflight = Math.max(maxInflight, inflight);
          await new Promise((r) => setTimeout(r, 5));
          inflight--;
          return new Response(JSON.stringify({ sessionId: "ma" }), { status: 202 });
        },
      } as ScrapeAgentSweepWorkflowEnv["DISCOVERY_WORKER"],
      _drizzleOverride: db,
    });
    await runWorkflow(env);
    expect(maxInflight).toBeLessThanOrEqual(3);
    expect(maxInflight).toBeGreaterThan(1);
    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    expect(run.dispatched).toBe(7);
  });
});
