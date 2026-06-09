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
  return { a, env: { DB: h.db } as unknown as Record<string, unknown> };
}

const BASE = "https://api.releases.sh";

beforeEach(async () => {
  h = createTestDb();
  await h.db.insert(user).values({
    id: "u1",
    name: "T",
    email: "t@e.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});
afterEach(() => h.cleanup());

describe("/v1/me/digest", () => {
  it("GET defaults to off before any pref is set", async () => {
    const { a, env } = app();
    const res = await a.request(`${BASE}/me/digest`, {}, env);
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ cadence: "off" });
  });

  it("PUT sets cadence and GET reflects it", async () => {
    const { a, env } = app();
    const put = await a.request(
      `${BASE}/me/digest`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cadence: "weekly" }),
      },
      env,
    );
    expect(put.status).toBe(200);
    expect((await put.json()) as any).toEqual({ cadence: "weekly" });

    const get = await a.request(`${BASE}/me/digest`, {}, env);
    expect((await get.json()) as any).toEqual({ cadence: "weekly" });
  });

  it("PUT rejects an invalid cadence with 400", async () => {
    const { a, env } = app();
    const res = await a.request(
      `${BASE}/me/digest`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cadence: "hourly" }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });
});
