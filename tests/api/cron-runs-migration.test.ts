import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { cronRuns } from "../../workers/api/src/db/schema-cron";
import { sql } from "drizzle-orm";

describe("cron_runs migration", () => {
  it("creates the table with all columns and the composite index", () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: "src/db/migrations" });

    const tables = sqlite
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='cron_runs'")
      .all();
    expect(tables.length).toBe(1);

    const indexes = sqlite
      .query(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cron_runs' AND name='idx_cron_runs_name_started'",
      )
      .all();
    expect(indexes.length).toBe(1);

    // Round-trip a row to confirm the column set matches the Drizzle schema
    db.insert(cronRuns)
      .values({
        id: "crun_testfixture",
        cronName: "scrape-agent-sweep",
        startedAt: "2026-04-18T01:00:00Z",
        status: "running",
      })
      .run();

    const [row] = db
      .select()
      .from(cronRuns)
      .where(sql`${cronRuns.id} = 'crun_testfixture'`)
      .all();
    expect(row.cronName).toBe("scrape-agent-sweep");
    expect(row.status).toBe("running");
    expect(row.candidates).toBe(0);
  });
});
