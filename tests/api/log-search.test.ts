import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../db-helper";
import { searchQueries } from "@buildinternet/releases-core/schema";
import { prepareSearchLogRow, MAX_QUERY_LEN } from "../../workers/api/src/lib/log-search";
import { prepareMcpSearchLogRow } from "../../workers/mcp/src/lib/log-search";

function mkDb() {
  const sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  return drizzle(sqlite);
}

describe("prepareSearchLogRow", () => {
  it("trims whitespace and JSON-encodes the types array", () => {
    const row = prepareSearchLogRow({
      surface: "web",
      query: "  next.js 15  ",
      mode: "hybrid",
      types: ["orgs", "catalog"],
      orgHits: 2,
      catalogHits: 1,
      releaseHits: 5,
      chunkHits: 0,
      degraded: false,
      durationMs: 42,
    });
    expect(row).not.toBeNull();
    expect(row!.query).toBe("next.js 15");
    expect(row!.surface).toBe("web");
    expect(row!.mode).toBe("hybrid");
    expect(row!.types).toBe(JSON.stringify(["orgs", "catalog"]));
    expect(row!.releaseHits).toBe(5);
    expect(row!.clientKind).toBe("external");
  });

  it("truncates queries longer than MAX_QUERY_LEN", () => {
    const row = prepareSearchLogRow({
      surface: "mcp",
      query: "x".repeat(MAX_QUERY_LEN + 50),
    });
    expect(row!.query.length).toBe(MAX_QUERY_LEN);
  });

  it("returns null for empty queries", () => {
    expect(prepareSearchLogRow({ surface: "web", query: "   " })).toBeNull();
  });

  it("returns null for unknown surfaces", () => {
    expect(prepareSearchLogRow({ surface: "android" as any, query: "ok" })).toBeNull();
  });

  it("drops invalid mode values rather than persisting them", () => {
    const row = prepareSearchLogRow({
      surface: "web",
      query: "kubernetes",
      mode: "fuzzy" as any,
    });
    expect(row!.mode).toBeNull();
  });

  it("inserts cleanly into the migrated schema", async () => {
    const db = mkDb();
    const row = prepareSearchLogRow({
      surface: "api",
      query: "kubernetes",
      anonId: "abc-123",
      sessionId: "sess-9",
      userAgent: "curl/8.1",
    })!;
    await db.insert(searchQueries).values(row);

    const rows = await db.select().from(searchQueries);
    expect(rows.length).toBe(1);
    expect(rows[0].anonId).toBe("abc-123");
    expect(rows[0].sessionId).toBe("sess-9");
    expect(rows[0].userAgent).toBe("curl/8.1");
  });
});

describe("prepareMcpSearchLogRow", () => {
  it("defaults the types array to the command name", () => {
    const row = prepareMcpSearchLogRow({
      command: "search",
      query: "vercel",
    });
    expect(row!.types).toBe(JSON.stringify(["search"]));
    expect(row!.surface).toBe("mcp");
  });

  it("preserves an explicit types array", () => {
    const row = prepareMcpSearchLogRow({
      command: "search_releases",
      query: "vercel",
      types: ["search_releases", "releases"],
    });
    expect(row!.types).toBe(JSON.stringify(["search_releases", "releases"]));
  });

  it("returns null for blank queries", () => {
    expect(prepareMcpSearchLogRow({ command: "search", query: " " })).toBeNull();
  });
});
