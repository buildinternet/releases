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

async function makeApp(db: ReturnType<typeof mkDb>) {
  const { Hono } = await import("hono");
  const { adminFeedbackRoutes } = await import("../src/routes/admin-feedback.js");
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", adminFeedbackRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, { DB: db });
}

async function seed(db: ReturnType<typeof mkDb>) {
  await db.insert(feedback).values([
    {
      id: "fb_1",
      createdAt: 1000,
      message: "first",
      type: "bug",
      status: "new",
      clientKind: "external",
      surface: "cli",
    },
    {
      id: "fb_2",
      createdAt: 2000,
      message: "second",
      type: "idea",
      status: "new",
      clientKind: "external",
      surface: "cli",
    },
    {
      id: "fb_3",
      createdAt: 3000,
      message: "third",
      type: "bug",
      status: "triaged",
      clientKind: "external",
      surface: "cli",
    },
  ]);
}

describe("GET /v1/admin/feedback", () => {
  it("returns rows newest-first", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const res = await fetch(new Request("http://x/v1/admin/feedback"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(json.items.map((r) => r.id)).toEqual(["fb_3", "fb_2", "fb_1"]);
  });

  it("filters by status and type", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const res = await fetch(new Request("http://x/v1/admin/feedback?status=new&type=bug"));
    const json = (await res.json()) as { items: { id: string }[] };
    expect(json.items.map((r) => r.id)).toEqual(["fb_1"]);
  });

  it("hides archived rows by default and shows them with includeArchived", async () => {
    const db = mkDb();
    await seed(db);
    await db.insert(feedback).values({
      id: "fb_archived",
      createdAt: 4000,
      message: "archived",
      type: "bug",
      status: "new",
      archived: true,
      clientKind: "external",
      surface: "cli",
    });
    const fetch = await makeApp(db);

    const def = (await (await fetch(new Request("http://x/v1/admin/feedback"))).json()) as {
      items: { id: string }[];
    };
    expect(def.items.map((r) => r.id)).not.toContain("fb_archived");
    expect(def.items.map((r) => r.id)).toEqual(["fb_3", "fb_2", "fb_1"]);

    const all = (await (
      await fetch(new Request("http://x/v1/admin/feedback?includeArchived=true"))
    ).json()) as { items: { id: string }[] };
    expect(all.items.map((r) => r.id)).toEqual(["fb_archived", "fb_3", "fb_2", "fb_1"]);
  });

  it("paginates via limit + cursor", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const first = (await (
      await fetch(new Request("http://x/v1/admin/feedback?limit=2"))
    ).json()) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(first.items.map((r) => r.id)).toEqual(["fb_3", "fb_2"]);
    expect(first.nextCursor).not.toBeNull();
    const second = (await (
      await fetch(new Request(`http://x/v1/admin/feedback?limit=2&cursor=${first.nextCursor}`))
    ).json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(second.items.map((r) => r.id)).toEqual(["fb_1"]);
    expect(second.nextCursor).toBeNull();
  });
});
