import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import { setDigestCadence, getDigestPrefs } from "../src/queries/digest-prefs.js";
import { digestRoutes } from "../src/routes/digest.js";

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
