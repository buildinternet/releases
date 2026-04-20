import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../db-helper";
import { cronRuns } from "../../workers/api/src/db/schema-cron";
import { reconcileStaleRunning } from "../../workers/api/src/db/cron-runs-dao";
import { eq } from "drizzle-orm";

function makeDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

describe("reconcileStaleRunning", () => {
  it("marks a >10min-old running row as aborted with stale_running", async () => {
    const db = makeDb();
    const now = new Date("2026-04-18T01:00:00Z");
    const staleStart = new Date(now.getTime() - 20 * 60 * 1000).toISOString();

    await db.insert(cronRuns).values({
      id: "crun_stale",
      cronName: "scrape-agent-sweep",
      startedAt: staleStart,
      status: "running",
    });

    const reconciled = await reconcileStaleRunning(db, {
      cronName: "scrape-agent-sweep",
      now,
      thresholdMs: 10 * 60 * 1000,
    });
    expect(reconciled).toBe(1);

    const [row] = await db.select().from(cronRuns).where(eq(cronRuns.id, "crun_stale"));
    expect(row.status).toBe("aborted");
    expect(row.abortReason).toBe("stale_running");
    expect(row.endedAt).toBe(now.toISOString());
  });

  it("leaves running rows younger than the threshold alone", async () => {
    const db = makeDb();
    const now = new Date("2026-04-18T01:00:00Z");
    const freshStart = new Date(now.getTime() - 2 * 60 * 1000).toISOString();

    await db.insert(cronRuns).values({
      id: "crun_fresh",
      cronName: "scrape-agent-sweep",
      startedAt: freshStart,
      status: "running",
    });

    const reconciled = await reconcileStaleRunning(db, {
      cronName: "scrape-agent-sweep",
      now,
      thresholdMs: 10 * 60 * 1000,
    });
    expect(reconciled).toBe(0);

    const [row] = await db.select().from(cronRuns).where(eq(cronRuns.id, "crun_fresh"));
    expect(row.status).toBe("running");
  });

  it("only touches rows of the matching cron_name", async () => {
    const db = makeDb();
    const now = new Date("2026-04-18T01:00:00Z");
    const staleStart = new Date(now.getTime() - 20 * 60 * 1000).toISOString();

    await db.insert(cronRuns).values({
      id: "crun_other",
      cronName: "retier",
      startedAt: staleStart,
      status: "running",
    });

    const reconciled = await reconcileStaleRunning(db, {
      cronName: "scrape-agent-sweep",
      now,
      thresholdMs: 10 * 60 * 1000,
    });
    expect(reconciled).toBe(0);

    const [row] = await db.select().from(cronRuns).where(eq(cronRuns.id, "crun_other"));
    expect(row.status).toBe("running");
  });
});
