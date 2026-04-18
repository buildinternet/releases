import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { cronRuns } from "../../workers/api/src/db/schema-cron";
import { insertRunningRow, finalizeRunRow } from "../../workers/api/src/db/cron-runs-dao";

function makeDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "src/db/migrations" });
  return { db, sqlite };
}

describe("cron_runs DAO", () => {
  it("inserts a running row and returns its id", async () => {
    const { db } = makeDb();
    const id = await insertRunningRow(db, { cronName: "scrape-agent-sweep", startedAt: "2026-04-18T01:00:00Z" });
    expect(id.startsWith("crun_")).toBe(true);
    const [row] = db.select().from(cronRuns).where(eq(cronRuns.id, id)).all();
    expect(row.status).toBe("running");
    expect(row.cronName).toBe("scrape-agent-sweep");
  });

  it("finalizes a running row with computed duration_ms", async () => {
    const { db } = makeDb();
    const id = await insertRunningRow(db, { cronName: "scrape-agent-sweep", startedAt: "2026-04-18T01:00:00Z" });
    await finalizeRunRow(db, id, {
      endedAt: "2026-04-18T01:00:02.500Z",
      status: "done",
      candidates: 5,
      dispatched: 5,
      skippedOverCap: 0,
      dispatchErrors: 0,
      sessionsStarted: ["ma-1", "ma-2"],
      dispatchErrorDetail: [],
      notes: "ok",
    });
    const [row] = db.select().from(cronRuns).where(eq(cronRuns.id, id)).all();
    expect(row.status).toBe("done");
    expect(row.durationMs).toBe(2500);
    expect(row.sessionsStarted).toBe(JSON.stringify(["ma-1", "ma-2"]));
    expect(row.dispatchErrorDetail).toBeNull();
  });

  it("writes dispatchErrorDetail as JSON when non-empty", async () => {
    const { db } = makeDb();
    const id = await insertRunningRow(db, { cronName: "scrape-agent-sweep", startedAt: "2026-04-18T01:00:00Z" });
    await finalizeRunRow(db, id, {
      endedAt: "2026-04-18T01:00:01Z",
      status: "degraded",
      candidates: 2,
      dispatched: 1,
      skippedOverCap: 0,
      dispatchErrors: 1,
      sessionsStarted: ["ma-1"],
      dispatchErrorDetail: [{ orgSlug: "bad-org", error: "500 boom" }],
      notes: null,
    });
    const [row] = db.select().from(cronRuns).where(eq(cronRuns.id, id)).all();
    expect(JSON.parse(row.dispatchErrorDetail!)).toEqual([{ orgSlug: "bad-org", error: "500 boom" }]);
  });

  it("truncates dispatchErrorDetail and sessionsStarted arrays to 20 entries", async () => {
    const { db } = makeDb();
    const id = await insertRunningRow(db, { cronName: "scrape-agent-sweep", startedAt: "2026-04-18T01:00:00Z" });
    const sessions = Array.from({ length: 30 }, (_, i) => `ma-${i}`);
    const errors = Array.from({ length: 30 }, (_, i) => ({ orgSlug: `o-${i}`, error: "e" }));
    await finalizeRunRow(db, id, {
      endedAt: "2026-04-18T01:00:01Z",
      status: "degraded",
      candidates: 30,
      dispatched: 20,
      skippedOverCap: 0,
      dispatchErrors: 10,
      sessionsStarted: sessions,
      dispatchErrorDetail: errors,
      notes: null,
    });
    const [row] = db.select().from(cronRuns).where(eq(cronRuns.id, id)).all();
    expect(JSON.parse(row.sessionsStarted!).length).toBe(20);
    expect(JSON.parse(row.dispatchErrorDetail!).length).toBe(20);
  });
});
