import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../db-helper";

describe("applyMigrations", () => {
  it("creates the full wrangler schema on a fresh sqlite DB", () => {
    const sqlite = new Database(":memory:");
    applyMigrations(sqlite);

    const rows = sqlite
      .query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type = 'table'")
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);

    expect(names).toContain("organizations");
    expect(names).toContain("sources");
    expect(names).toContain("releases");
    expect(names).toContain("cron_runs");
    expect(names).toContain("webhook_subscriptions");
    expect(names).toContain("releases_fts");
  });

  it("is idempotent-safe to call on a fresh DB", () => {
    const sqlite = new Database(":memory:");
    expect(() => applyMigrations(sqlite)).not.toThrow();
  });
});
