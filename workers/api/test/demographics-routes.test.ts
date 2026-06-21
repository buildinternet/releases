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
const EMPTY = {
  optedIn: false,
  birthYear: null,
  birthDate: null,
  gender: null,
  genderCustom: null,
  sexualOrientation: null,
  sexualOrientationCustom: null,
  countryCode: null,
};

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

describe("/v1/me/demographics", () => {
  it("GET returns empty defaults before any row exists", async () => {
    const { a, env } = app();
    const res = await a.request(`${BASE}/me/demographics`, {}, env);
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual(EMPTY);
  });

  it("PUT stores year-only birth info and GET reflects it", async () => {
    const { a, env } = app();
    const payload = {
      ...EMPTY,
      optedIn: true,
      birthYear: 1990,
      gender: "non_binary",
    };
    const put = await a.request(
      `${BASE}/me/demographics`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(put.status).toBe(200);
    expect((await put.json()) as any).toEqual(payload);

    const get = await a.request(`${BASE}/me/demographics`, {}, env);
    expect((await get.json()) as any).toEqual(payload);
  });

  it("PUT stores full birth date with matching year", async () => {
    const { a, env } = app();
    const payload = {
      ...EMPTY,
      optedIn: true,
      birthYear: 1988,
      birthDate: "1988-06-15",
      sexualOrientation: "bisexual",
      countryCode: "US",
    };
    const put = await a.request(
      `${BASE}/me/demographics`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(put.status).toBe(200);
    expect((await put.json()) as any).toEqual(payload);
  });

  it("PUT rejects mismatched birth year and date", async () => {
    const { a, env } = app();
    const res = await a.request(
      `${BASE}/me/demographics`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...EMPTY,
          optedIn: true,
          birthYear: 1990,
          birthDate: "1988-06-15",
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("PUT requires genderCustom when gender is custom", async () => {
    const { a, env } = app();
    const res = await a.request(
      `${BASE}/me/demographics`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...EMPTY, optedIn: true, gender: "custom" }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });
});
