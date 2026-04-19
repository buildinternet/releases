import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { sources, organizations } from "@releases/core-internal/schema";
import { cronRuns } from "../../workers/api/src/db/schema-cron";
import { scrapeAgentSweep } from "../../workers/api/src/cron/scrape-agent-sweep";
import { desc } from "drizzle-orm";

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "src/db/migrations" });
  db.insert(organizations).values([
    { id: "org_a", name: "Org A", slug: "a", category: "developer-tools" },
    { id: "org_b", name: "Org B", slug: "b", category: "developer-tools" },
    { id: "org_c", name: "Org C", slug: "c", category: "developer-tools" },
  ]).run();
  db.insert(sources).values([
    { id: "src_1", name: "S1", slug: "s-1", type: "scrape", url: "https://a.com/c", orgId: "org_a", changeDetectedAt: "2026-04-18T00:00:00Z", metadata: "{}" },
    { id: "src_2", name: "S2", slug: "s-2", type: "scrape", url: "https://a.com/d", orgId: "org_a", changeDetectedAt: "2026-04-18T00:01:00Z", metadata: "{}" },
    { id: "src_3", name: "S3", slug: "s-3", type: "scrape", url: "https://b.com/c", orgId: "org_b", changeDetectedAt: "2026-04-18T00:02:00Z", metadata: "{}" },
    { id: "src_4", name: "S4", slug: "s-4", type: "scrape", url: "https://c.com/c", orgId: "org_c", changeDetectedAt: "2026-04-18T00:03:00Z", metadata: "{}" },
  ]).run();
  return db;
}

function mkEnv(overrides: Partial<any> = {}) {
  return {
    DB: {} as any,
    CRON_ENABLED: "true",
    SCRAPE_AGENT_CRON_ENABLED: "true",
    SCRAPE_AGENT_MAX_SESSIONS: "20",
    DISCOVERY_WORKER: { fetch: async () => new Response(JSON.stringify({ sessionId: "ma-auto" }), { status: 202 }) },
    RELEASED_API_KEY: "test-key",
    ANTHROPIC_API_KEY: "test-anthropic-key",
    ...overrides,
  };
}

describe("scrapeAgentSweep (E2E)", () => {
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    // Default: preflight succeeds. Override per-test when a different response is needed.
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
          return new Response(JSON.stringify({ sessionId: `ma-${dispatchCount}` }), { status: 202 });
        },
      },
    });
    await scrapeAgentSweep({ ...env, _drizzleOverride: db } as any);
    expect(dispatchCount).toBe(3);
    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    expect(run.status).toBe("done");
    expect(run.dispatched).toBe(3);
    expect(run.candidates).toBe(4);
    expect(JSON.parse(run.sessionsStarted!).length).toBe(3);
  });

  it("pre-flight auth failure: aborts with no dispatches", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })) as unknown as typeof fetch;
    const db = mkDb();
    let dispatchCount = 0;
    const env = mkEnv({
      DISCOVERY_WORKER: {
        fetch: async () => { dispatchCount++; return new Response("{}", { status: 202 }); },
      },
    });
    await scrapeAgentSweep({ ...env, _drizzleOverride: db } as any);
    expect(dispatchCount).toBe(0);
    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    expect(run.status).toBe("aborted");
    expect(run.abortReason).toBe("anthropic_auth");
  });

  it("mixed dispatch: 2 succeed, 1 errors -> degraded", async () => {
    const db = mkDb();
    let callCount = 0;
    const env = mkEnv({
      DISCOVERY_WORKER: {
        fetch: async () => {
          callCount++;
          if (callCount === 2) return new Response("500 boom", { status: 500 });
          return new Response(JSON.stringify({ sessionId: `ma-${callCount}` }), { status: 202 });
        },
      },
    });
    await scrapeAgentSweep({ ...env, _drizzleOverride: db } as any);
    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    expect(run.status).toBe("degraded");
    expect(run.dispatched).toBe(2);
    expect(run.dispatchErrors).toBe(1);
    expect(JSON.parse(run.dispatchErrorDetail!)).toHaveLength(1);
  });

  it("cap enforcement: 25 candidates + cap=20 -> 20 dispatched, skipped=5", async () => {
    const db = mkDb();
    for (let i = 0; i < 21; i++) {
      db.insert(organizations).values({ id: `org_extra_${i}`, name: `Org ${i}`, slug: `extra-${i}`, category: "developer-tools" }).run();
      // Pre-date extras so under ASC they drain first. 21 slots starting 24h before base.
      const ts = `2026-04-17T03:${String(i).padStart(2, "0")}:00Z`;
      db.insert(sources).values({ id: `src_extra_${i}`, name: `S${i}`, slug: `se-${i}`, type: "scrape", url: `https://extra-${i}.com/c`, orgId: `org_extra_${i}`, changeDetectedAt: ts, metadata: "{}" }).run();
    }
    let dispatchCount = 0;
    const env = mkEnv({
      SCRAPE_AGENT_MAX_SESSIONS: "20",
      DISCOVERY_WORKER: {
        fetch: async () => { dispatchCount++; return new Response(JSON.stringify({ sessionId: `ma-${dispatchCount}` }), { status: 202 }); },
      },
    });
    await scrapeAgentSweep({ ...env, _drizzleOverride: db } as any);
    expect(dispatchCount).toBe(20);
    const [run] = db.select().from(cronRuns).orderBy(desc(cronRuns.startedAt)).all();
    expect(run.candidates).toBe(20);
    expect(run.skippedOverCap).toBe(5);
  });

  it("no candidates: writes a done row with notes", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: "src/db/migrations" });
    const env = mkEnv();
    await scrapeAgentSweep({ ...env, _drizzleOverride: db } as any);
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
        fetch: async () => { dispatchCount++; return new Response("{}", { status: 202 }); },
      },
    });
    await scrapeAgentSweep({ ...env, _drizzleOverride: db } as any);
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
        fetch: async () => { dispatchCount++; return new Response("{}", { status: 202 }); },
      },
    });
    await scrapeAgentSweep({ ...env, _drizzleOverride: db } as any);
    expect(dispatchCount).toBe(0);
    const rows = db.select().from(cronRuns).all();
    expect(rows.length).toBe(0);
  });
});
