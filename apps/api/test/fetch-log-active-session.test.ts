import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources, fetchLog } from "@buildinternet/releases-core/schema";
import type { D1Db } from "../src/db.js";
import type { ActiveFetchSession, ListResponse } from "@buildinternet/releases-api-types";
import { Hono } from "hono";
import { fetchLogRoutes } from "../src/routes/fetch-log.js";

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

/**
 * STATUS_HUB DO namespace stub. `sessionMap`/`sessions` drive the
 * /active-sources → /sessions/:id join the route performs through getStatusHub.
 */
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
  await db.insert(fetchLog).values({
    id: "fl_1",
    sourceId: "src_a1",
    status: "no_change",
    releasesFound: 0,
    releasesInserted: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
  });
}

function mkApp(db: D1Db, statusHub: unknown) {
  const fakeEnv = { DB: db, STATUS_HUB: statusHub };
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", fetchLogRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, fakeEnv as never);
}

type Enveloped = ListResponse<unknown> & { activeSession?: ActiveFetchSession | null };

describe("GET /v1/admin/logs/fetch — activeSession overlay", () => {
  it("includes the running activeSession in the enveloped, source-filtered response", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db, mkStatusHub({ "acme-one": "ma-run" }, { "ma-run": RUNNING_SESSION }));

    const res = await fetch(
      new Request("https://x.test/v1/admin/logs/fetch?source=src_a1&envelope=true"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Enveloped;
    expect(body.items).toHaveLength(1);
    expect(body.activeSession).toEqual({
      sessionId: "ma-run",
      status: "running",
      startedAt: 1_000,
      lastUpdatedAt: 2_000,
    });
  });

  it("sets activeSession to null when no fetch is running for the source", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db, mkStatusHub({}, {}));

    const res = await fetch(
      new Request("https://x.test/v1/admin/logs/fetch?source=src_a1&envelope=true"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Enveloped;
    expect(body.activeSession).toBeNull();
  });

  it("leaves the bare-array form unchanged (no activeSession field) when not enveloped", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db, mkStatusHub({ "acme-one": "ma-run" }, { "ma-run": RUNNING_SESSION }));

    const res = await fetch(new Request("https://x.test/v1/admin/logs/fetch?source=src_a1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect((body as unknown[]).length).toBe(1);
  });
});
