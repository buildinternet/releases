import { describe, it, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { user } from "../../workers/api/src/db/schema-auth.js";
import { userApiKeyHandlers } from "../../workers/api/src/routes/user-api-keys.js";
import type { Env } from "../../workers/api/src/index.js";

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

function env() {
  return {
    ENVIRONMENT: "test",
    BETTER_AUTH_SECRET: "test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    BETTER_AUTH_URL: "https://api.releases.localhost",
    USER_API_KEYS_ENABLED: "true",
    DB: h!.db,
    // oxlint-disable-next-line no-explicit-any
  } as any;
}

function seedUser(id: string, email: string) {
  h!.db
    .insert(user)
    .values({
      id,
      name: "U",
      email,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
}

/** Mount the handlers behind a middleware that injects a fixed session. */
function appAs(userId: string) {
  const a = new Hono<Env>();
  a.use("*", (c, next) => {
    c.set("session", { user: { id: userId, email: `${userId}@e.com`, name: "U" } });
    return next();
  });
  a.route("/", userApiKeyHandlers);
  return a;
}

async function post(userId: string, body: unknown) {
  return appAs(userId).request(
    "/api-keys",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    env(),
  );
}

describe("POST /v1/api-keys (create)", () => {
  it("rejects scope 'admin' with 400 (server-side cap)", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    const res = await post("user_1", { name: "k", scope: "admin" });
    expect(res.status).toBe(400);
  });

  it("rejects a missing/garbage scope with 400", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    expect((await post("user_1", { name: "k" })).status).toBe(400);
    expect((await post("user_1", { name: "k", scope: "owner" })).status).toBe(400);
  });

  it("rejects an empty name with 400", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    expect((await post("user_1", { name: "  ", scope: "read" })).status).toBe(400);
  });

  it("creates a read key and reveals it exactly once", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    const res = await post("user_1", { name: "ci", scope: "read" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      key: string;
      id: string;
      scope: string;
      start: string | null;
    };
    expect(body.key.startsWith("relu_")).toBe(true);
    expect(body.scope).toBe("read");
    expect(body.id).toBeTruthy();
  });

  it("creates a write key whose stored scope is write", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    const res = await post("user_1", { name: "ci", scope: "write" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { scope: string };
    expect(body.scope).toBe("write");
  });

  it("rejects an out-of-range expiry with 400", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    expect((await post("user_1", { name: "k", scope: "read", expiresInDays: 0 })).status).toBe(400);
    expect((await post("user_1", { name: "k", scope: "read", expiresInDays: 999 })).status).toBe(
      400,
    );
  });
});

async function list(userId: string) {
  const res = await appAs(userId).request("/api-keys", {}, env());
  return {
    status: res.status,
    body: (await res.json()) as { apiKeys: Array<Record<string, unknown>> },
  };
}

describe("GET /v1/api-keys (list)", () => {
  it("returns only the caller's keys, never the secret", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    seedUser("user_2", "u2@e.com");
    await post("user_1", { name: "mine", scope: "read" });
    await post("user_2", { name: "theirs", scope: "write" });

    const { status, body } = await list("user_1");
    expect(status).toBe(200);
    expect(body.apiKeys).toHaveLength(1);
    const k = body.apiKeys[0]!;
    expect(k.name).toBe("mine");
    expect(k.scope).toBe("read");
    expect("key" in k).toBe(false); // the hashed/secret key is never projected
    expect(typeof k.id).toBe("string");
  });

  it("returns an empty list for a user with no keys", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    const { status, body } = await list("user_1");
    expect(status).toBe(200);
    expect(body.apiKeys).toEqual([]);
  });
});
