import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations } from "../../../tests/db-helper";
import { user } from "../src/db/schema-auth.js";

function mkDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=ON");
  applyMigrations(sqlite);
  return drizzle(sqlite);
}

async function makeApp(db: ReturnType<typeof mkDb>) {
  const { Hono } = await import("hono");
  const { adminUsersRoutes } = await import("../src/routes/admin-users.js");
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", adminUsersRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, { DB: db });
}

async function seed(db: ReturnType<typeof mkDb>) {
  await db.insert(user).values([
    { id: "u_admin", name: "Ada", email: "ada@example.com", role: "admin" },
    { id: "u_cur", name: "Cory", email: "cory@example.com", role: "curator" },
    { id: "u_plain", name: "Pat", email: "pat@example.com" }, // role NULL
  ]);
}

function patch(body: unknown): Request {
  return new Request("http://x/v1/admin/users/role", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /v1/admin/users/role", () => {
  it("sets a role by email and returns previous + new", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const res = await fetch(patch({ email: "pat@example.com", role: "curator" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      userId: string;
      role: string;
      previousRole: string | null;
    };
    expect(json).toMatchObject({ userId: "u_plain", role: "curator", previousRole: null });
    const [row] = await db.select({ role: user.role }).from(user).where(eq(user.id, "u_plain"));
    expect(row.role).toBe("curator");
  });

  it("revokes by setting role back to user", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const res = await fetch(patch({ userId: "u_admin", role: "user" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { previousRole: string | null; role: string };
    expect(json).toMatchObject({ previousRole: "admin", role: "user" });
  });

  it("rejects an unknown role with 400", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const res = await fetch(patch({ email: "pat@example.com", role: "superadmin" }));
    expect(res.status).toBe(400);
  });

  it("rejects neither/both identifiers with 400", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    expect((await fetch(patch({ role: "curator" }))).status).toBe(400);
    expect(
      (await fetch(patch({ email: "pat@example.com", userId: "u_plain", role: "curator" }))).status,
    ).toBe(400);
  });

  it("returns 404 for a missing user", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const res = await fetch(patch({ email: "nobody@example.com", role: "curator" }));
    expect(res.status).toBe(404);
  });

  it("emits a role-changed audit line", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => {
      lines.push(String(a[0]));
    };
    try {
      await fetch(patch({ email: "pat@example.com", role: "admin" }));
    } finally {
      console.log = orig;
    }
    const audit = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.event === "role-changed");
    expect(audit).toMatchObject({
      component: "auth",
      targetUserId: "u_plain",
      fromRole: null,
      toRole: "admin",
      actor: "root-key",
    });
  });
});

describe("GET /v1/admin/users/role", () => {
  it("reads a user's current role by email", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const res = await fetch(new Request("http://x/v1/admin/users/role?email=cory@example.com"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: "u_cur", role: "curator" });
  });

  it("404s an unknown user", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const res = await fetch(new Request("http://x/v1/admin/users/role?email=ghost@example.com"));
    expect(res.status).toBe(404);
  });

  it("400s when neither identifier is given", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const res = await fetch(new Request("http://x/v1/admin/users/role"));
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/admin/users/roles", () => {
  it("lists only curator/admin users", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = await makeApp(db);
    const res = await fetch(new Request("http://x/v1/admin/users/roles"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { users: { userId: string; role: string }[] };
    expect(json.users.map((u) => u.userId).sort()).toEqual(["u_admin", "u_cur"]);
  });
});
