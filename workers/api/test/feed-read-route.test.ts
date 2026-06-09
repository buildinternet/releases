import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import { upsertFeedToken } from "../src/queries/feed-tokens.js";
import { feedRoutes } from "../src/routes/feed.js";

let h: TestDatabase;

function app() {
  const a = new Hono();
  a.route("/", feedRoutes);
  const env = {
    DB: h.db,
    WEB_BASE_URL: "https://releases.sh",
    MEDIA_ORIGIN: "https://media.releases.sh",
  } as unknown as Record<string, unknown>;
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
});
afterEach(() => h.cleanup());

describe("GET /v1/feed/:token", () => {
  it("renders an Atom feed for a valid token (empty follows → valid empty feed)", async () => {
    const { a, env } = app();
    const { token } = await upsertFeedToken(h.db, "u1");
    const res = await a.request(`/feed/${token}.atom`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/atom+xml");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.text();
    expect(body).toContain("<feed");
    expect(body).toContain("Your followed releases");
  });

  it("404s for a malformed token", async () => {
    const { a, env } = app();
    const res = await a.request("/feed/garbage.atom", {}, env);
    expect(res.status).toBe(404);
  });

  it("404s for an unknown (well-formed) token", async () => {
    const { a, env } = app();
    const res = await a.request(`/feed/relf_${"a".repeat(12)}_${"b".repeat(32)}.atom`, {}, env);
    expect(res.status).toBe(404);
  });

  it("404s after the token is revoked", async () => {
    const { a, env } = app();
    const { token } = await upsertFeedToken(h.db, "u1");
    await upsertFeedToken(h.db, "u1"); // rotate → old token invalid
    const res = await a.request(`/feed/${token}.atom`, {}, env);
    expect(res.status).toBe(404);
  });
});
