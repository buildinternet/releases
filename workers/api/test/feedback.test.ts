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

// True if the string contains any C0/C1 control char except tab (0x09) and
// newline (0x0a). Built from char codes so no literal control bytes live in
// this source file.
function hasDisallowedControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const allowed = c === 0x09 || c === 0x0a;
    if (!allowed && (c <= 0x1f || (c >= 0x7f && c <= 0x9f))) return true;
  }
  return false;
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

  it("rejects a non-object JSON body (null) with 400, not 500", async () => {
    const db = mkDb();
    const fetch = await makeApp(db);
    const res = await fetch(post(null));
    expect(res.status).toBe(400);
    const rows = await db.select().from(feedback);
    expect(rows).toHaveLength(0);
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

  it("returns 429 when the per-IP rate limiter rejects", async () => {
    const db = mkDb();
    const fetch = await makeApp(db, {
      FEEDBACK_RATE_LIMITER: { limit: async () => ({ success: false }) },
    });
    const res = await fetch(post({ message: "rate limited please" }));
    expect(res.status).toBe(429);
    const rows = await db.select().from(feedback);
    expect(rows).toHaveLength(0);
  });

  it("allows the request when the rate limiter succeeds", async () => {
    const db = mkDb();
    const fetch = await makeApp(db, {
      FEEDBACK_RATE_LIMITER: { limit: async () => ({ success: true }) },
    });
    const res = await fetch(post({ message: "under the limit, fine" }));
    expect(res.status).toBe(202);
  });

  it("rejects an oversized body with 413 before parsing", async () => {
    const db = mkDb();
    const fetch = await makeApp(db);
    const res = await fetch(
      new Request("http://x/v1/feedback", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(100_000) },
        body: JSON.stringify({ message: "x".repeat(90_000) }),
      }),
    );
    expect(res.status).toBe(413);
    const rows = await db.select().from(feedback);
    expect(rows).toHaveLength(0);
  });

  it("strips control characters (incl. ANSI escape) from message and contact", async () => {
    const db = mkDb();
    const fetch = await makeApp(db);
    const ESC = String.fromCharCode(0x1b);
    const BELL = String.fromCharCode(0x07);
    const NUL = String.fromCharCode(0x00);
    const CR = String.fromCharCode(0x0d);
    await fetch(
      post({
        message: `clean${ESC}[31mred${BELL} and${NUL} bell${CR} text`,
        contact: `evil${ESC}[2Jcontact@example.com`,
      }),
    );
    const rows = await db.select().from(feedback);
    expect(hasDisallowedControl(rows[0]!.message)).toBe(false);
    expect(hasDisallowedControl(rows[0]!.contact ?? "")).toBe(false);
    expect(rows[0]!.message).toContain("clean");
    expect(rows[0]!.message).toContain("red");
  });

  it("preserves newlines and tabs in the message", async () => {
    const db = mkDb();
    const fetch = await makeApp(db);
    await fetch(post({ message: "line one\nline two\tindented" }));
    const rows = await db.select().from(feedback);
    expect(rows[0]!.message).toContain("\n");
    expect(rows[0]!.message).toContain("\t");
  });

  it("stores new feedback as not archived", async () => {
    const db = mkDb();
    const fetch = await makeApp(db);
    await fetch(post({ message: "fresh feedback, not archived" }));
    const rows = await db.select().from(feedback);
    expect(rows[0]!.archived).toBe(false);
  });
});

async function seedOne(
  db: ReturnType<typeof mkDb>,
  overrides: Partial<typeof feedback.$inferInsert> = {},
) {
  const row = {
    id: "fb_seed",
    createdAt: 1000,
    message: "seed feedback row",
    type: "bug",
    status: "new",
    archived: false,
    clientKind: "external",
    surface: "cli",
    ...overrides,
  };
  await db.insert(feedback).values(row);
  return row;
}

function patch(id: string, body: unknown) {
  return new Request(`http://x/v1/feedback/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /v1/feedback/:id", () => {
  it("updates status and returns the updated row", async () => {
    const db = mkDb();
    await seedOne(db);
    const fetch = await makeApp(db);
    const res = await fetch(patch("fb_seed", { status: "closed" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string; status: string };
    expect(json.id).toBe("fb_seed");
    expect(json.status).toBe("closed");
    const [row] = await db.select().from(feedback);
    expect(row!.status).toBe("closed");
  });

  it("archives a row (and can restore it)", async () => {
    const db = mkDb();
    await seedOne(db);
    const fetch = await makeApp(db);

    const archived = await fetch(patch("fb_seed", { archived: true }));
    expect(archived.status).toBe(200);
    expect((await db.select().from(feedback))[0]!.archived).toBe(true);

    const restored = await fetch(patch("fb_seed", { archived: false }));
    expect(restored.status).toBe(200);
    expect((await db.select().from(feedback))[0]!.archived).toBe(false);
  });

  it("can set status and archived in one request", async () => {
    const db = mkDb();
    await seedOne(db);
    const fetch = await makeApp(db);
    const res = await fetch(patch("fb_seed", { status: "triaged", archived: true }));
    expect(res.status).toBe(200);
    const [row] = await db.select().from(feedback);
    expect(row!.status).toBe("triaged");
    expect(row!.archived).toBe(true);
  });

  it("rejects an invalid status with 400", async () => {
    const db = mkDb();
    await seedOne(db);
    const fetch = await makeApp(db);
    const res = await fetch(patch("fb_seed", { status: "nonsense" }));
    expect(res.status).toBe(400);
    expect((await db.select().from(feedback))[0]!.status).toBe("new");
  });

  it("rejects a non-boolean archived with 400", async () => {
    const db = mkDb();
    await seedOne(db);
    const fetch = await makeApp(db);
    const res = await fetch(patch("fb_seed", { archived: "yes" }));
    expect(res.status).toBe(400);
  });

  it("rejects an empty body with 400", async () => {
    const db = mkDb();
    await seedOne(db);
    const fetch = await makeApp(db);
    const res = await fetch(patch("fb_seed", {}));
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown id", async () => {
    const db = mkDb();
    const fetch = await makeApp(db);
    const res = await fetch(patch("fb_missing", { status: "closed" }));
    expect(res.status).toBe(404);
  });
});

describe("DELETE /v1/feedback/:id", () => {
  it("hard-deletes the row and returns deleted:true", async () => {
    const db = mkDb();
    await seedOne(db);
    const fetch = await makeApp(db);
    const res = await fetch(new Request("http://x/v1/feedback/fb_seed", { method: "DELETE" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { deleted: boolean; id: string };
    expect(json.deleted).toBe(true);
    expect(json.id).toBe("fb_seed");
    expect(await db.select().from(feedback)).toHaveLength(0);
  });

  it("returns 404 for an unknown id", async () => {
    const db = mkDb();
    await seedOne(db);
    const fetch = await makeApp(db);
    const res = await fetch(new Request("http://x/v1/feedback/fb_missing", { method: "DELETE" }));
    expect(res.status).toBe(404);
    expect(await db.select().from(feedback)).toHaveLength(1);
  });
});
