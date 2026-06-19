import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import { meHandlers } from "../src/routes/me.js";

let h: TestDatabase;

function app() {
  const a = new Hono();
  a.onError((err, c) => {
    if (err instanceof HTTPException) {
      const status = err.status;
      return c.json(
        { error: status === 400 ? "bad_request" : "http_error", message: err.message },
        status,
      );
    }
    return c.json({ error: "internal_error", message: String(err) }, 500);
  });
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

  it("PUT rejects malformed JSON with 400 invalid JSON body", async () => {
    const { a, env } = app();
    const res = await a.request(
      `${BASE}/me/digest`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      },
      env,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe("bad_request");
    expect(json.message).toBe("invalid JSON body");
  });
});
