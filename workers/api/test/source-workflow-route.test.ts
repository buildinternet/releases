import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources, fetchLog, usageLog } from "@buildinternet/releases-core/schema";
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

async function seed(db: D1Db) {
  await db
    .insert(organizations)
    .values({ id: "org_a", slug: "acme", name: "Acme", category: "cloud" });
  await db.insert(sources).values({
    id: "src_blog",
    orgId: "org_a",
    slug: "blog",
    name: "Blog",
    url: "https://acme.test",
    type: "scrape",
    fetchPriority: "normal",
    metadata: JSON.stringify({ marketingFilter: true }),
  });
  const t0 = new Date(Date.now() - 60_000).toISOString();
  await db.insert(fetchLog).values([
    {
      id: "fl_1",
      sourceId: "src_blog",
      releasesFound: 3,
      releasesInserted: 2,
      durationMs: 2400,
      status: "success",
      createdAt: t0,
    },
    {
      id: "fl_0",
      sourceId: "src_blog",
      releasesFound: 0,
      releasesInserted: 0,
      durationMs: 100,
      status: "no_change",
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    },
  ]);
  await db.insert(usageLog).values({
    operation: "extract",
    model: "x",
    inputTokens: 10,
    outputTokens: 5,
    sourceId: "src_blog",
    createdAt: t0,
  });
}

describe("GET /v1/status/source-workflow", () => {
  it("returns adaptive stages + derived lastRun/sparkline/aiPasses", async () => {
    const db = mkDb();
    await seed(db);
    const res = await mkApp(db)(
      new Request("https://x.test/v1/status/source-workflow?sourceId=src_blog"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stages: { key: string }[];
      lastRun: { status: string; releasesInserted: number };
      sparkline: string[];
      aiPasses: { operation: string }[];
    };
    expect(body.stages.map((s) => s.key)).toEqual([
      "poll",
      "fetch",
      "hash",
      "extract",
      "classify",
      "upsert",
      "summarize",
      "embed",
      "publish",
    ]);
    expect(body.lastRun.status).toBe("success");
    expect(body.lastRun.releasesInserted).toBe(2);
    expect(body.sparkline).toEqual(["no_change", "success"]); // oldest→newest
    expect(body.aiPasses.some((p) => p.operation === "extract")).toBe(true);
  });

  it("400 without sourceId, 404 for unknown id", async () => {
    const db = mkDb();
    await seed(db);
    const app = mkApp(db);
    expect((await app(new Request("https://x.test/v1/status/source-workflow"))).status).toBe(400);
    expect(
      (await app(new Request("https://x.test/v1/status/source-workflow?sourceId=nope"))).status,
    ).toBe(404);
  });

  it("aiPasses: only in-window usage rows, aggregated by operation", async () => {
    const db = mkDb();
    await db
      .insert(organizations)
      .values({ id: "org_b", slug: "beta", name: "Beta", category: "cloud" });
    await db.insert(sources).values({
      id: "src_w",
      orgId: "org_b",
      slug: "w",
      name: "W",
      url: "https://w.test",
      type: "scrape",
      fetchPriority: "normal",
      metadata: "{}",
    });
    const t0 = new Date(Date.now() - 60_000).toISOString();
    await db.insert(fetchLog).values({
      id: "fl_w",
      sourceId: "src_w",
      releasesFound: 1,
      releasesInserted: 1,
      durationMs: 500,
      status: "success",
      createdAt: t0,
    });
    const inWin1 = new Date(Date.parse(t0) - 60_000).toISOString();
    const inWin2 = new Date(Date.parse(t0) + 60_000).toISOString();
    const outWin = new Date(Date.parse(t0) - 10 * 60_000).toISOString();
    await db.insert(usageLog).values([
      {
        operation: "extract",
        model: "x",
        inputTokens: 10,
        outputTokens: 5,
        sourceId: "src_w",
        createdAt: inWin1,
      },
      {
        operation: "extract",
        model: "x",
        inputTokens: 7,
        outputTokens: 3,
        sourceId: "src_w",
        createdAt: inWin2,
      },
      {
        operation: "summarize",
        model: "x",
        inputTokens: 100,
        outputTokens: 50,
        sourceId: "src_w",
        createdAt: outWin,
      },
    ]);
    const res = await mkApp(db)(
      new Request("https://x.test/v1/status/source-workflow?sourceId=src_w"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      aiPasses: { operation: string; count: number; inputTokens: number; outputTokens: number }[];
    };
    const extract = body.aiPasses.find((p) => p.operation === "extract");
    expect(extract).toBeTruthy();
    expect(extract!.count).toBe(2);
    expect(extract!.inputTokens).toBe(17);
    expect(extract!.outputTokens).toBe(8);
    expect(body.aiPasses.find((p) => p.operation === "summarize")).toBeUndefined();
  });

  it("no fetch_log: lastRun null, empty aiPasses + sparkline, stages still present", async () => {
    const db = mkDb();
    await db
      .insert(organizations)
      .values({ id: "org_c", slug: "gamma", name: "Gamma", category: "cloud" });
    await db.insert(sources).values({
      id: "src_e",
      orgId: "org_c",
      slug: "e",
      name: "E",
      url: "https://e.test",
      type: "github",
      fetchPriority: "normal",
      metadata: "{}",
    });
    const res = await mkApp(db)(
      new Request("https://x.test/v1/status/source-workflow?sourceId=src_e"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lastRun: unknown;
      aiPasses: unknown[];
      sparkline: unknown[];
      stages: unknown[];
    };
    expect(body.lastRun).toBeNull();
    expect(body.aiPasses).toEqual([]);
    expect(body.sparkline).toEqual([]);
    expect(body.stages.length).toBeGreaterThan(0);
  });
});
