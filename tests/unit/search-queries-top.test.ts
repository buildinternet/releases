import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../db-helper";
import { searchQueries } from "@buildinternet/releases-core/schema";
import { getTopSearchQueries } from "../../workers/api/src/lib/search-queries-top";

function mkDb() {
  const sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  return drizzle(sqlite);
}

const NOW = Date.now();

type SeedRow = {
  id: string;
  timestamp: number;
  query: string;
  surface?: string;
  userAgent?: string | null;
};

/** Seed helper: batch-insert rows without requiring all optional fields. */
async function seed(db: ReturnType<typeof mkDb>, rows: SeedRow[]) {
  await db.insert(searchQueries).values(
    rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      query: r.query,
      surface: (r.surface ?? "web") as "web" | "mcp" | "api",
      clientKind: "external",
      userAgent: r.userAgent !== undefined ? r.userAgent : "TestClient/1.0",
    })),
  );
}

describe("getTopSearchQueries", () => {
  it("returns empty array when no rows exist", async () => {
    const db = mkDb();
    const rows = await getTopSearchQueries(db, { since: NOW - 86_400_000 });
    expect(rows).toHaveLength(0);
  });

  it("groups by query text and counts occurrences", async () => {
    const db = mkDb();
    await seed(db, [
      { id: "sq_1", timestamp: NOW - 1000, query: "next.js" },
      { id: "sq_2", timestamp: NOW - 2000, query: "next.js" },
      { id: "sq_3", timestamp: NOW - 3000, query: "kubernetes" },
    ]);
    const rows = await getTopSearchQueries(db, { since: NOW - 86_400_000 });
    expect(rows).toHaveLength(2);
    expect(rows[0].query).toBe("next.js");
    expect(rows[0].count).toBe(2);
    expect(rows[1].query).toBe("kubernetes");
    expect(rows[1].count).toBe(1);
  });

  it("orders by count descending", async () => {
    const db = mkDb();
    await seed(db, [
      { id: "sq_a", timestamp: NOW - 1000, query: "single" },
      { id: "sq_b", timestamp: NOW - 2000, query: "triple" },
      { id: "sq_c", timestamp: NOW - 3000, query: "triple" },
      { id: "sq_d", timestamp: NOW - 4000, query: "triple" },
      { id: "sq_e", timestamp: NOW - 5000, query: "double" },
      { id: "sq_f", timestamp: NOW - 6000, query: "double" },
    ]);
    const rows = await getTopSearchQueries(db, { since: NOW - 86_400_000 });
    expect(rows[0].query).toBe("triple");
    expect(rows[1].query).toBe("double");
    expect(rows[2].query).toBe("single");
  });

  it("returns lastSeen as the max timestamp for the group", async () => {
    const db = mkDb();
    await seed(db, [
      { id: "sq_1", timestamp: NOW - 10_000, query: "react" },
      { id: "sq_2", timestamp: NOW - 1_000, query: "react" },
    ]);
    const rows = await getTopSearchQueries(db, { since: NOW - 86_400_000 });
    expect(rows).toHaveLength(1);
    expect(rows[0].lastSeen).toBe(NOW - 1_000);
  });

  it("excludes rows outside the since window", async () => {
    const db = mkDb();
    await seed(db, [
      { id: "sq_old", timestamp: NOW - 2 * 86_400_000, query: "stale" },
      { id: "sq_new", timestamp: NOW - 1_000, query: "fresh" },
    ]);
    const rows = await getTopSearchQueries(db, { since: NOW - 86_400_000 });
    expect(rows).toHaveLength(1);
    expect(rows[0].query).toBe("fresh");
  });

  it("excludes bot user agents by default", async () => {
    const db = mkDb();
    await seed(db, [
      { id: "sq_bot", timestamp: NOW - 1000, query: "bot query", userAgent: "Googlebot/2.1" },
      { id: "sq_human", timestamp: NOW - 2000, query: "human query", userAgent: "Mozilla/5.0" },
      { id: "sq_null", timestamp: NOW - 3000, query: "null ua query", userAgent: null },
      { id: "sq_empty", timestamp: NOW - 4000, query: "empty ua query", userAgent: "" },
    ]);
    const rows = await getTopSearchQueries(db, { since: NOW - 86_400_000 });
    expect(rows).toHaveLength(1);
    expect(rows[0].query).toBe("human query");
  });

  it("includes bot rows when excludeBots is false", async () => {
    const db = mkDb();
    await seed(db, [
      { id: "sq_bot", timestamp: NOW - 1000, query: "bot query", userAgent: "Googlebot/2.1" },
      { id: "sq_human", timestamp: NOW - 2000, query: "human query", userAgent: "Mozilla/5.0" },
    ]);
    const rows = await getTopSearchQueries(db, { since: NOW - 86_400_000, excludeBots: false });
    expect(rows).toHaveLength(2);
  });

  it("respects the limit option", async () => {
    const db = mkDb();
    await seed(db, [
      { id: "sq_a", timestamp: NOW - 1000, query: "a" },
      { id: "sq_b", timestamp: NOW - 2000, query: "b" },
      { id: "sq_c", timestamp: NOW - 3000, query: "c" },
    ]);
    const rows = await getTopSearchQueries(db, { since: NOW - 86_400_000, limit: 2 });
    expect(rows).toHaveLength(2);
  });

  it("defaults to limit 20", async () => {
    const db = mkDb();
    // Insert 25 distinct queries (one per batch insert) to verify the default cap.
    await seed(
      db,
      Array.from({ length: 25 }, (_, i) => ({
        id: `sq_${i}`,
        timestamp: NOW - i * 1000,
        query: `query-${i}`,
      })),
    );
    const rows = await getTopSearchQueries(db, { since: NOW - 86_400_000 });
    expect(rows).toHaveLength(20);
  });
});
