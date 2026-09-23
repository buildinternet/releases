import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import type { D1Db } from "../src/db.js";
import { Hono } from "hono";
import { sourceRoutes } from "../src/routes/sources.js";

/**
 * Characterization + regression guard for GET /v1/sources/:slug/sessions: it
 * returns the active running session for a source as `{ sessions: [<full
 * session>] }`, or `{ sessions: [] }` when none is active. This wire shape must
 * survive the DRY refactor onto getActiveSessionRaw (#1360).
 */
function mkDb(): D1Db {
  const sqlite = new Database(":memory:");
  const rawDb = drizzle(sqlite);
  applyMigrations(sqlite);
  return ensureBatchShim(rawDb) as unknown as D1Db;
}

const RUNNING_SESSION = {
  sessionId: "ma-run",
  type: "update",
  status: "running",
  startedAt: 1_000,
  lastUpdatedAt: 2_000,
  activeSources: ["acme-one"],
};

function mkStatusHub(sessionMap: Record<string, string>, sessions: Record<string, unknown>) {
  const stub = {
    fetch: async (req: Request) => {
      const path = new URL(req.url).pathname;
      if (path === "/active-sources") {
        return new Response(JSON.stringify({ slugs: Object.keys(sessionMap), sessionMap }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      const m = path.match(/^\/sessions\/(.+)$/);
      if (m) {
        const s = sessions[decodeURIComponent(m[1])];
        if (!s) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        return new Response(JSON.stringify(s), { headers: { "Content-Type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    },
  };
  return { idFromName: () => "global-id", get: () => stub };
}

async function seed(db: D1Db) {
  await db
    .insert(organizations)
    .values({ id: "org_a", slug: "acme", name: "Acme", category: "cloud" });
  await db.insert(sources).values({
    id: "src_a1",
    orgId: "org_a",
    slug: "acme-one",
    name: "Acme One",
    url: "https://a.test/changelog",
    type: "scrape",
  });
}

function mkApp(db: D1Db, statusHub: unknown) {
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", sourceRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, { DB: db, STATUS_HUB: statusHub } as never);
}

describe("GET /v1/sources/:slug/sessions", () => {
  it("returns the active running session as { sessions: [session] }", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db, mkStatusHub({ "acme-one": "ma-run" }, { "ma-run": RUNNING_SESSION }));

    const res = await fetch(new Request("https://x.test/v1/sources/src_a1/sessions"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(body.sessions).toEqual([RUNNING_SESSION]);
  });

  it("returns { sessions: [] } when no fetch is running for the source", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db, mkStatusHub({}, {}));

    const res = await fetch(new Request("https://x.test/v1/sources/src_a1/sessions"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(body.sessions).toEqual([]);
  });
});
