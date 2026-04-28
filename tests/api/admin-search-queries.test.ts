import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { applyMigrations } from "../db-helper";
import { searchQueries } from "@buildinternet/releases-core/schema";
import { adminSearchQueriesRoutes } from "../../workers/api/src/routes/admin-search-queries";

function mkDb() {
  const sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  return drizzle(sqlite);
}

function mkApp(db: any) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as any).set("db", db);
    await next();
  });
  app.route("/", adminSearchQueriesRoutes);
  return app;
}

const NOW = Date.now();

async function seed(db: any) {
  await db.insert(searchQueries).values([
    {
      id: "sq_1",
      timestamp: NOW - 60_000,
      surface: "web",
      query: "next.js",
      clientKind: "external",
    },
    {
      id: "sq_2",
      timestamp: NOW - 120_000,
      surface: "web",
      query: "next.js",
      clientKind: "external",
    },
    {
      id: "sq_3",
      timestamp: NOW - 180_000,
      surface: "mcp",
      query: "kubernetes",
      clientKind: "external",
    },
    {
      id: "sq_old",
      timestamp: NOW - 30 * 86_400_000,
      surface: "web",
      query: "stale",
      clientKind: "external",
    },
  ]);
}

describe("GET /admin/search-queries", () => {
  it("returns recent rows newest-first", async () => {
    const db = mkDb();
    await seed(db);
    const res = await mkApp(db).request("/admin/search-queries?since=1d");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((r) => r.id)).toEqual(["sq_1", "sq_2", "sq_3"]);
  });

  it("filters by surface", async () => {
    const db = mkDb();
    await seed(db);
    const res = await mkApp(db).request("/admin/search-queries?surface=mcp&since=1d");
    const body = (await res.json()) as Array<{ id: string; surface: string }>;
    expect(body.length).toBe(1);
    expect(body[0].surface).toBe("mcp");
  });

  it("ignores unknown surface values rather than 400ing", async () => {
    const db = mkDb();
    await seed(db);
    const res = await mkApp(db).request("/admin/search-queries?surface=android&since=1d");
    const body = (await res.json()) as unknown[];
    expect(res.status).toBe(200);
    expect(body.length).toBe(3);
  });
});

describe("GET /admin/search-queries/top", () => {
  it("groups by query and counts descending", async () => {
    const db = mkDb();
    await seed(db);
    const res = await mkApp(db).request("/admin/search-queries/top?since=1d");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ query: string; count: number }>;
    expect(body[0]).toEqual(expect.objectContaining({ query: "next.js", count: 2 }));
    expect(body[1]).toEqual(expect.objectContaining({ query: "kubernetes", count: 1 }));
  });

  it("scopes the count window via since=", async () => {
    const db = mkDb();
    await seed(db);
    const res = await mkApp(db).request("/admin/search-queries/top?since=60d");
    const body = (await res.json()) as Array<{ query: string; count: number }>;
    const stale = body.find((r) => r.query === "stale");
    expect(stale).toBeDefined();
  });
});
