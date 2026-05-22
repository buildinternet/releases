import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import { feedback } from "@buildinternet/releases-core/schema";

function mkDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=ON");
  applyMigrations(sqlite);
  return drizzle(sqlite);
}

async function makeApp(db: ReturnType<typeof mkDb>, env: Record<string, unknown> = {}) {
  const { Hono } = await import("hono");
  const { feedbackRoutes } = await import("../src/routes/feedback.js");
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", feedbackRoutes);
  app.route("/v1", v1);
  const fakeEnv = { DB: db, SEND_EMAIL: undefined, ...env };
  return (req: Request) =>
    app.fetch(req, fakeEnv, {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext);
}

function post(body: unknown) {
  return new Request("http://x/v1/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/feedback", () => {
  it("stores valid feedback and returns 202 + id", async () => {
    const db = mkDb();
    const fetch = await makeApp(db);
    const res = await fetch(
      post({ message: "scoped search misses obvious hits", type: "bug", cliVersion: "0.43.0" }),
    );
    expect(res.status).toBe(202);
    const json = (await res.json()) as { ok: boolean; id: string };
    expect(json.ok).toBe(true);
    expect(json.id.startsWith("fb_")).toBe(true);
    const rows = await db.select().from(feedback);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message).toBe("scoped search misses obvious hits");
    expect(rows[0]!.type).toBe("bug");
  });

  it("defaults an omitted type to general", async () => {
    const db = mkDb();
    const fetch = await makeApp(db);
    await fetch(post({ message: "just a general note here" }));
    const rows = await db.select().from(feedback);
    expect(rows[0]!.type).toBe("general");
  });

  it("rejects an empty/short message with 400", async () => {
    const db = mkDb();
    const fetch = await makeApp(db);
    const res = await fetch(post({ message: "hi" }));
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON with 400", async () => {
    const db = mkDb();
    const fetch = await makeApp(db);
    const res = await fetch(
      new Request("http://x/v1/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 503 when FEEDBACK_DISABLED=true", async () => {
    const db = mkDb();
    const fetch = await makeApp(db, { FEEDBACK_DISABLED: "true" });
    const res = await fetch(post({ message: "this should not be stored" }));
    expect(res.status).toBe(503);
    const rows = await db.select().from(feedback);
    expect(rows).toHaveLength(0);
  });

  it("caps an over-long message and coerces an unknown type to general", async () => {
    const db = mkDb();
    const fetch = await makeApp(db);
    await fetch(post({ message: "y".repeat(5000), type: "nonsense" }));
    const rows = await db.select().from(feedback);
    expect(rows[0]!.message.length).toBe(4000);
    expect(rows[0]!.type).toBe("general");
  });
});
