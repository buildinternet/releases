import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import { setDigestCadence, getDigestPrefs } from "../src/queries/digest-prefs.js";
import { digestRoutes } from "../src/routes/digest.js";
import { publicRateLimit } from "../src/middleware/rate-limit.js";

let h: TestDatabase;

function app() {
  const a = new Hono();
  a.route("/", digestRoutes);
  return {
    a,
    env: { DB: h.db, WEB_BASE_URL: "https://releases.sh" } as unknown as Record<string, unknown>,
  };
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

describe("/v1/digest/unsubscribe/:token", () => {
  it("POST with a valid token sets cadence off (idempotent)", async () => {
    const row = await setDigestCadence(h.db, "u1", "daily");
    const { a, env } = app();
    const res = await a.request(
      `${BASE}/digest/unsubscribe/${row.manageToken}`,
      { method: "POST" },
      env,
    );
    expect(res.status).toBe(200);
    expect((await getDigestPrefs(h.db, "u1"))!.cadence).toBe("off");
    const again = await a.request(
      `${BASE}/digest/unsubscribe/${row.manageToken}`,
      { method: "POST" },
      env,
    );
    expect(again.status).toBe(200);
  });

  it("POST with a bad token → opaque 404", async () => {
    const { a, env } = app();
    const res = await a.request(`${BASE}/digest/unsubscribe/reld_nope`, { method: "POST" }, env);
    expect(res.status).toBe(404);
  });

  it("GET with a valid token confirms + unsubscribes", async () => {
    const row = await setDigestCadence(h.db, "u1", "weekly");
    const { a, env } = app();
    const res = await a.request(`${BASE}/digest/unsubscribe/${row.manageToken}`, {}, env);
    expect(res.status).toBe(200);
    expect((await getDigestPrefs(h.db, "u1"))!.cadence).toBe("off");
  });
});

/**
 * The RFC 8058 One-Click target is the POST, and the default
 * `publicRateLimitMiddleware` waves non-safe methods straight through — so
 * mounting it here without `unsafeMethods` left the one form an attacker would
 * script completely unthrottled while looking protected (#2158).
 */
describe("unsubscribe rate limiting", () => {
  function limitedApp(calls: string[], success: boolean) {
    const a = new Hono();
    a.use("/digest/unsubscribe/:token", publicRateLimit({ unsafeMethods: true }));
    a.route("/", digestRoutes);
    return {
      a,
      env: {
        DB: h.db,
        RATE_LIMIT_ENABLED: "true",
        PUBLIC_RATE_LIMITER: {
          limit: async ({ key }: { key: string }) => {
            calls.push(key);
            return { success };
          },
        },
      } as unknown as Record<string, unknown>,
    };
  }

  it("throttles the one-click POST, not just the GET", async () => {
    const calls: string[] = [];
    const { a, env } = limitedApp(calls, false);
    const res = await a.request(
      `${BASE}/digest/unsubscribe/reld_whatever`,
      { method: "POST", headers: { "cf-connecting-ip": "203.0.113.9" } },
      env,
    );
    expect(res.status).toBe(429);
    expect(calls).toEqual(["203.0.113.9"]);
  });

  it("still unsubscribes when the limiter allows the request", async () => {
    const row = await setDigestCadence(h.db, "u1", "daily");
    const calls: string[] = [];
    const { a, env } = limitedApp(calls, true);
    const res = await a.request(
      `${BASE}/digest/unsubscribe/${row.manageToken}`,
      { method: "POST", headers: { "cf-connecting-ip": "203.0.113.9" } },
      env,
    );
    expect(res.status).toBe(200);
    expect((await getDigestPrefs(h.db, "u1"))?.cadence).toBe("off");
  });
});
