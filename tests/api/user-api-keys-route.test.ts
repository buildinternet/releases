import { describe, it, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { user } from "../../workers/api/src/db/schema-auth.js";
import { apikey } from "../../workers/api/src/db/schema-auth.js";
import { userApiKeyHandlers } from "../../workers/api/src/routes/user-api-keys.js";
import type { Env } from "../../workers/api/src/index.js";

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

const IDEMPOTENCY_SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const IDEMPOTENCY_KEY = "user-key-create-1";

function env(idempotencySecret: string | null = IDEMPOTENCY_SECRET) {
  return {
    ENVIRONMENT: "test",
    BETTER_AUTH_SECRET: "test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    BETTER_AUTH_URL: "https://api.releases.localhost",
    USER_API_KEYS_ENABLED: "true",
    DB: h!.db,
    ...(idempotencySecret === null
      ? {}
      : { IDEMPOTENCY_ENCRYPTION_KEY: { get: async () => idempotencySecret } }),
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

async function post(
  userId: string,
  body: unknown,
  options: { idempotencyKey?: string; secret?: string | null } = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  return appAs(userId).request(
    "/api-keys",
    { method: "POST", headers, body: JSON.stringify(body) },
    env(options.secret),
  );
}

describe("POST /v1/api-keys (create)", () => {
  it("rejects scope 'admin' with 400 (server-side cap)", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    const res = await post("user_1", { name: "k", scope: "admin" });
    expect(res.status).toBe(400);
  });

  it("defaults a missing scope to read; rejects a garbage scope with 400", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    const missing = await post("user_1", { name: "k" });
    expect(missing.status).toBe(201);
    expect(((await missing.json()) as { scope: string }).scope).toBe("read");
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

  it("rejects scope 'write' with 400 (read-only ceiling)", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    const res = await post("user_1", { name: "ci", scope: "write" });
    expect(res.status).toBe(400);
  });

  it("rejects an out-of-range expiry with 400", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    expect((await post("user_1", { name: "k", scope: "read", expiresInDays: 0 })).status).toBe(400);
    expect((await post("user_1", { name: "k", scope: "read", expiresInDays: 999 })).status).toBe(
      400,
    );
  });

  it("replays the reveal-once API key once and stores one credential", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    const first = await post(
      "user_1",
      { name: "ci", scope: "read" },
      { idempotencyKey: IDEMPOTENCY_KEY },
    );
    const firstBody = (await first.clone().json()) as { key: string };
    const replay = await post(
      "user_1",
      { name: "ci", scope: "read" },
      { idempotencyKey: IDEMPOTENCY_KEY },
    );
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(((await replay.json()) as { key: string }).key).toBe(firstBody.key);
    expect((await h.db.select().from(apikey)).length).toBe(1);
  });

  it("conflicts for a changed API-key request and leaves headerless creates independent", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    expect(
      (await post("user_1", { name: "first" }, { idempotencyKey: IDEMPOTENCY_KEY })).status,
    ).toBe(201);
    expect(
      (await post("user_1", { name: "changed" }, { idempotencyKey: IDEMPOTENCY_KEY })).status,
    ).toBe(409);
    expect((await post("user_1", { name: "second" })).status).toBe(201);
    expect((await post("user_1", { name: "third" })).status).toBe(201);
    expect((await h.db.select().from(apikey)).length).toBe(3);
  });

  it("requires idempotency encryption before creating an API key", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    expect(
      (await post("user_1", { name: "ci" }, { idempotencyKey: IDEMPOTENCY_KEY, secret: null }))
        .status,
    ).toBe(503);
    expect((await h.db.select().from(apikey)).length).toBe(0);
  });

  it("enforces the API-key name UTF-8 byte cap", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    expect((await post("user_1", { name: "é".repeat(100) })).status).toBe(201);
    expect((await post("user_1", { name: "é".repeat(100) + "a" })).status).toBe(400);
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
    await post("user_2", { name: "theirs", scope: "read" });

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

async function del(userId: string, id: string) {
  return appAs(userId).request(`/api-keys/${id}`, { method: "DELETE" }, env());
}

describe("DELETE /v1/api-keys/:id (revoke)", () => {
  it("deletes the caller's own key", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    const created = (await (await post("user_1", { name: "k", scope: "read" })).json()) as {
      id: string;
    };
    const res = await del("user_1", created.id);
    expect(res.status).toBe(200);
    expect((await list("user_1")).body.apiKeys).toHaveLength(0);
  });

  it("cannot delete another user's key (404, indistinct from absent)", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    seedUser("user_2", "u2@e.com");
    const created = (await (await post("user_2", { name: "k", scope: "read" })).json()) as {
      id: string;
    };
    const res = await del("user_1", created.id);
    expect(res.status).toBe(404);
    // and user_2's key still exists
    expect((await list("user_2")).body.apiKeys).toHaveLength(1);
  });

  it("404 for an absent id", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    expect((await del("user_1", "ak_nope")).status).toBe(404);
  });
});
