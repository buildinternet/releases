import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { desc } from "drizzle-orm";
import { applyMigrations } from "../db-helper";
import { sources, organizations } from "@buildinternet/releases-core/schema";
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

  it("no candidates: writes a done row with notes", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    applyMigrations(sqlite);
    const env = mkEnv({ _drizzleOverride: db });
    await runWorkflow(env);
    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    expect(run.status).toBe("done");
    expect(run.candidates).toBe(0);
    expect(run.notes).toBe("no flagged sources");
  });

  it("CRON_ENABLED=false: short-circuits without writing a cron_runs row", async () => {
    const db = mkDb();
    let dispatchCount = 0;
    const env = mkEnv({
      CRON_ENABLED: "false",
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
    const rows = db.select().from(cronRuns).all();
    expect(rows.length).toBe(0);
  });

  it("SCRAPE_AGENT_CRON_ENABLED=false: short-circuits without writing a cron_runs row", async () => {
    const db = mkDb();
    let dispatchCount = 0;
    const env = mkEnv({
      SCRAPE_AGENT_CRON_ENABLED: "false",
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
    const rows = db.select().from(cronRuns).all();
    expect(rows.length).toBe(0);
  });
});
