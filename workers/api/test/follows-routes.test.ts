import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { organizations, products } from "@buildinternet/releases-core/schema";
import { user } from "../src/db/schema-auth.js";
import { meHandlers } from "../src/routes/me.js";

let h: TestDatabase;

/** Mount the no-auth handlers behind a middleware that injects a fixed session. */
function app() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    (c as any).set("session", { user: { id: "u1", email: "t@e.com", name: "T" } });
    await next();
  });
  a.route("/", meHandlers);
  // Handlers resolve the db via createDb(c.env.DB); createDb passes a drizzle
  // handle through unchanged (see db.ts), so a bun:sqlite handle on env.DB works.
  const env = { DB: h.db } as unknown as Record<string, unknown>;
  return { a, env };
}

beforeEach(async () => {
  h = createTestDb();
  await h.db.insert(user).values({
    id: "u1",
    name: "T",
    email: "t@e.com",
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await h.db.insert(organizations).values({ id: "org_a", name: "Acme", slug: "acme" });
  await h.db
    .insert(products)
    .values({ id: "prd_p", name: "Widget", slug: "widget", orgId: "org_a" });
});

afterEach(() => h.cleanup());

describe("/v1/me follows routes", () => {
  it("POST follows then GET lists it", async () => {
    const { a, env } = app();
    const post = await a.request(
      "/me/follows",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType: "org", targetId: "org_a" }),
      },
      env,
    );
    expect(post.status).toBe(201);
    const list = await a.request("/me/follows", {}, env);
    const body = (await list.json()) as { follows: Array<{ targetId: string }> };
    expect(body.follows.map((f) => f.targetId)).toEqual(["org_a"]);
  });

  it("POST is idempotent", async () => {
    const { a, env } = app();
    const body = JSON.stringify({ targetType: "product", targetId: "prd_p" });
    const headers = { "Content-Type": "application/json" };
    await a.request("/me/follows", { method: "POST", headers, body }, env);
    const second = await a.request("/me/follows", { method: "POST", headers, body }, env);
    expect(second.status).toBe(200);
    const list = await a.request("/me/follows", {}, env);
    expect(((await list.json()) as { follows: unknown[] }).follows).toHaveLength(1);
  });

  it("POST a non-existent target → 404", async () => {
    const { a, env } = app();
    const res = await a.request(
      "/me/follows",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType: "org", targetId: "nope" }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("POST with a bad targetType → 400", async () => {
    const { a, env } = app();
    const res = await a.request(
      "/me/follows",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType: "source", targetId: "x" }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("DELETE unfollows (idempotent)", async () => {
    const { a, env } = app();
    const body = JSON.stringify({ targetType: "org", targetId: "org_a" });
    await a.request(
      "/me/follows",
      { method: "POST", headers: { "Content-Type": "application/json" }, body },
      env,
    );
    const del = await a.request("/me/follows/org/org_a", { method: "DELETE" }, env);
    expect(del.status).toBe(200);
    const again = await a.request("/me/follows/org/org_a", { method: "DELETE" }, env);
    expect(again.status).toBe(200);
    const list = await a.request("/me/follows", {}, env);
    expect(((await list.json()) as { follows: unknown[] }).follows).toHaveLength(0);
  });

  it("GET /me/feed returns the list envelope", async () => {
    const { a, env } = app();
    const res = await a.request("/me/feed", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; pagination: { page: number } };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.pagination.page).toBe(1);
  });
});
