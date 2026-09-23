import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import { meHandlers } from "../src/routes/me.js";

let h: TestDatabase;

function app() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    (c as any).set("session", { user: { id: "u1", email: "t@e.com", name: "T" } });
    await next();
  });
  a.route("/", meHandlers);
  const env = { DB: h.db } as unknown as Record<string, unknown>;
  return { a, env };
}

// Request full URLs (not bare paths) so `new URL(c.req.url).origin` is
// deterministic — Hono's test client otherwise defaults the origin to
// http://localhost.
const BASE = "https://api.releases.sh";

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
});
afterEach(() => h.cleanup());

describe("/v1/me/feed/token", () => {
  it("GET returns null before any token is minted", async () => {
    const { a, env } = app();
    const res = await a.request(`${BASE}/me/feed/token`, {}, env);
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ token: null });
  });

  it("POST mints a token and GET re-reveals the same feedUrl", async () => {
    const { a, env } = app();
    const post = await a.request(`${BASE}/me/feed/token`, { method: "POST" }, env);
    expect(post.status).toBe(201);
    const minted = (await post.json()) as { feedUrl: string; lookupId: string };
    expect(minted.feedUrl).toContain("https://api.releases.sh/v1/feed/relf_");
    expect(minted.feedUrl).toContain(".atom");

    const get = await a.request(`${BASE}/me/feed/token`, {}, env);
    const body = (await get.json()) as { token: { feedUrl: string } | null };
    expect(body.token?.feedUrl).toBe(minted.feedUrl);
  });

  it("POST again rotates to a different feedUrl", async () => {
    const { a, env } = app();
    const first = (await (
      await a.request(`${BASE}/me/feed/token`, { method: "POST" }, env)
    ).json()) as { feedUrl: string };
    const second = (await (
      await a.request(`${BASE}/me/feed/token`, { method: "POST" }, env)
    ).json()) as { feedUrl: string };
    expect(second.feedUrl).not.toBe(first.feedUrl);
  });

  it("DELETE revokes — GET then returns null", async () => {
    const { a, env } = app();
    await a.request(`${BASE}/me/feed/token`, { method: "POST" }, env);
    const del = await a.request(`${BASE}/me/feed/token`, { method: "DELETE" }, env);
    expect(del.status).toBe(200);
    const get = await a.request(`${BASE}/me/feed/token`, {}, env);
    expect((await get.json()) as any).toEqual({ token: null });
  });
});
