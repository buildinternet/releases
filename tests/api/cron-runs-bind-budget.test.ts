import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { cronRuns } from "../../workers/api/src/db/schema-cron";
import { D1_MAX_BINDINGS } from "../../workers/api/src/lib/d1-limits";

const db = drizzle(new Database(":memory:"));

describe("cron_runs bind budget", () => {
  it("INSERT (initial running row) stays well under D1's 100-bind cap", () => {
    const q = db.insert(cronRuns).values({
      id: "crun_x",
      cronName: "scrape-agent-sweep",
      startedAt: "2026-04-18T01:00:00Z",
      status: "running",
    }).toSQL();
    expect(q.params.length).toBeLessThanOrEqual(D1_MAX_BINDINGS);
    expect(q.params.length).toBeLessThan(10);
  });

  it("UPDATE (final row with all observability columns set) stays under cap", () => {
    const q = db.update(cronRuns).set({
      endedAt: "2026-04-18T01:00:02Z",
      durationMs: 2000,
      status: "done",
      candidates: 14,
      dispatched: 14,
      skippedOverCap: 0,
      dispatchErrors: 0,
      sessionsStarted: JSON.stringify(["ma-1", "ma-2"]),
      dispatchErrorDetail: null,
      abortReason: null,
      notes: "ok",
    }).where(eq(cronRuns.id, "crun_x")).toSQL();
    expect(q.params.length).toBeLessThanOrEqual(D1_MAX_BINDINGS);
    expect(q.params.length).toBeLessThan(20);
  });
});
