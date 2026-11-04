import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import { telemetryEvents } from "@buildinternet/releases-core/schema";

function mkDb() {
  const sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  return drizzle(sqlite);
}

async function makeApp(db: ReturnType<typeof mkDb>, env: Record<string, unknown> = {}) {
  const { Hono } = await import("hono");
  const { telemetryRoutes } = await import("../src/routes/telemetry.js");
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", telemetryRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, { DB: db, ...env });
}

const event = {
  surface: "cli",
  command: "search",
  anonId: "anon_1",
  cliVersion: "1.2.3",
  timestamp: 1,
};

function post(body: string, headers: Record<string, string> = {}) {
  return new Request("http://x/v1/telemetry", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4", ...headers },
    body,
  });
}

describe("POST /v1/telemetry", () => {
  it("stores a valid event", async () => {
    const db = mkDb();
    const fetch = await makeApp(db);
    const res = await fetch(post(JSON.stringify(event)));
    expect(res.status).toBe(202);
    expect(await db.select().from(telemetryEvents)).toHaveLength(1);
  });

  it("refuses an oversized body without writing", async () => {
    const db = mkDb();
    const fetch = await makeApp(db);
    const res = await fetch(post(JSON.stringify({ ...event, os: "x".repeat(10_000) })));
    expect(res.status).toBe(413);
    expect(await db.select().from(telemetryEvents)).toHaveLength(0);
  });

  it("rejects non-object JSON", async () => {
    const db = mkDb();
    const fetch = await makeApp(db);
    const res = await fetch(post("[1,2,3]"));
    expect(res.status).toBe(400);
  });

  it("rate limits per IP when the limiter says no", async () => {
    const db = mkDb();
    const keys: string[] = [];
    let allowed = 2;
    const fetch = await makeApp(db, {
      TELEMETRY_RATE_LIMITER: {
        limit: async ({ key }: { key: string }) => {
          keys.push(key);
          return { success: allowed-- > 0 };
        },
      },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      // oxlint-disable-next-line no-await-in-loop -- sequential limiter calls
      statuses.push((await fetch(post(JSON.stringify(event)))).status);
    }
    expect(statuses).toEqual([202, 202, 429]);
    expect(keys.every((k) => k === "telemetry:1.2.3.4")).toBe(true);
    expect(await db.select().from(telemetryEvents)).toHaveLength(2);
  });
});
