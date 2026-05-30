import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import type { D1Db } from "../src/db.js";

const { Hono } = await import("hono");
const { statusRoutes } = await import("../src/routes/status.js");

function mkDb(): D1Db {
  const sqlite = new Database(":memory:");
  const rawDb = drizzle(sqlite);
  applyMigrations(sqlite);
  return ensureBatchShim(rawDb) as unknown as D1Db;
}

function mkApp(db: D1Db) {
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", statusRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, { DB: db } as never);
}

interface PlanRow {
  slug: string;
  fetchPriority: string;
  plan: { strategy: string; intervalLabel: string; cadence: string; paused: boolean };
  state: { nextDueAt: string | null; paused: boolean };
}

async function seed(db: D1Db) {
  await db
    .insert(organizations)
    .values({ id: "org_a", slug: "acme", name: "Acme", category: "cloud" });
  await db.insert(sources).values([
    {
      id: "src_fc",
      orgId: "org_a",
      slug: "acme-firecrawl",
      name: "Acme Firecrawl",
      url: "https://a.test/fc",
      type: "scrape",
      metadata: JSON.stringify({ firecrawl: { enabled: true, schedule: "every 12 hours" } }),
      fetchPriority: "normal",
    },
    {
      id: "src_paused",
      orgId: "org_a",
      slug: "acme-paused",
      name: "Acme Paused",
      url: "https://a.test/p",
      type: "feed",
      metadata: JSON.stringify({ feedUrl: "https://a.test/feed", feedType: "rss" }),
      fetchPriority: "paused",
    },
  ]);
}

describe("GET /v1/status/fetch-plan", () => {
  it("returns one row per org source with resolved strategy + state", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/status/fetch-plan?org=acme"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sources: PlanRow[] };
    expect(body.sources).toHaveLength(2);

    const fc = body.sources.find((s) => s.slug === "acme-firecrawl")!;
    expect(fc.plan.strategy).toBe("firecrawl");
    expect(fc.plan.intervalLabel).toBe("every 12 hours");
    expect(fc.plan.cadence).toBe("firecrawl-webhook");
    expect(fc.fetchPriority).toBe("normal");
    expect(fc.state.nextDueAt).toBeNull();

    const paused = body.sources.find((s) => s.slug === "acme-paused")!;
    expect(paused.plan.strategy).toBe("feed");
    expect(paused.plan.intervalLabel).toBe("paused");
    expect(paused.plan.paused).toBe(true);
    expect(paused.fetchPriority).toBe("paused");
    expect(paused.state.nextDueAt).toBeNull();
  });

  it("returns 400 when org is missing", async () => {
    const db = mkDb();
    const fetch = mkApp(db);
    const res = await fetch(new Request("https://x.test/v1/status/fetch-plan"));
    expect(res.status).toBe(400);
  });

  it("returns an empty list for an unknown org", async () => {
    const db = mkDb();
    const fetch = mkApp(db);
    const res = await fetch(new Request("https://x.test/v1/status/fetch-plan?org=nope"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sources: PlanRow[] };
    expect(body.sources).toEqual([]);
  });
});
