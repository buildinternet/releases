import { describe, it, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { apiTokenRoutes } from "../../workers/api/src/routes/api-tokens.js";
import type { AuthContext } from "../../workers/api/src/middleware/auth.js";
import { apiTokens, idempotencyRecords } from "@buildinternet/releases-core/schema";
import { parseApiToken, hashSecret } from "@buildinternet/releases-core/api-token";
import { eq } from "drizzle-orm";

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

const IDEMPOTENCY_SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const IDEMPOTENCY_KEY = "token-create-key";

function call(db: TestDatabase["db"], idempotencySecret: string | null = IDEMPOTENCY_SECRET) {
  const a = new Hono<Env>();
  // Simulate the admin middleware having attached a root identity.
  a.use("*", async (c, next) => {
    c.set("auth", { kind: "root", scopes: ["*"] });
    await next();
  });
  a.route("/", apiTokenRoutes);
  return (path: string, init?: RequestInit) =>
    a.request(path, init, {
      DB: db,
      ...(idempotencySecret === null
        ? {}
        : { IDEMPOTENCY_ENCRYPTION_KEY: { get: async () => idempotencySecret } }),
    } as Env["Bindings"]);
}

describe("POST /v1/tokens", () => {
  it("mints a token, returns it once, stores only the hash", async () => {
    h = createTestDb();
    const res = await call(h.db)("/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "CI", scopes: ["write"] }),
    });
    expect(res.status).toBe(201);
    const text = await res.text();
    const body = JSON.parse(text) as { token: string; id: string; scopes: string[] };
    expect(body.token).toMatch(/^relk_/);
    expect(body.scopes).toEqual(["write"]);

    const parsed = parseApiToken(body.token)!;
    const row = h.db.select().from(apiTokens).where(eq(apiTokens.id, body.id)).get();
    expect(row?.tokenHash).toBe(await hashSecret(parsed.secret));
    expect(row?.principalType).toBe("internal");
    // The stored row never contains the plaintext secret.
    expect(JSON.stringify(row)).not.toContain(parsed.secret);
    // The create response never leaks the token hash.
    expect(text).not.toContain(row!.tokenHash);
  });

  it("rejects an invalid principalType", async () => {
    h = createTestDb();
    const res = await call(h.db)("/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", scopes: ["read"], principalType: "god" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing scopes", async () => {
    h = createTestDb();
    const res = await call(h.db)("/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects the wildcard scope", async () => {
    h = createTestDb();
    const res = await call(h.db)("/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", scopes: ["*"] }),
    });
    expect(res.status).toBe(400);
  });

  it("replays the reveal-once token for the same idempotency key and request", async () => {
    h = createTestDb();
    const request = {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": IDEMPOTENCY_KEY },
      body: JSON.stringify({ name: "CI", scopes: ["write", "read", "write"] }),
    };

    const first = await call(h.db)("/tokens", request);
    const second = await call(h.db)("/tokens", request);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await second.text()).toBe(await first.clone().text());
    expect((await h.db.select().from(apiTokens)).length).toBe(1);
    expect(((await first.json()) as { scopes: string[] }).scopes).toEqual(["read", "write"]);
  });

  it("canonicalizes a parseable oversized expiry before capture and replays the secret", async () => {
    h = createTestDb();
    const expiresAt = `${" ".repeat(65_200)}Jan 2, 2026`;
    const body = JSON.stringify({ name: "expiry", scopes: ["read"], expiresAt });
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(64 * 1024);
    const request = {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "expiry-create-key" },
      body,
    };

    const first = await call(h.db)("/tokens", request);
    const second = await call(h.db)("/tokens", request);

    expect(first.status).toBe(201);
    expect((await first.clone().arrayBuffer()).byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(second.status).toBe(201);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await second.text()).toBe(await first.clone().text());
    expect(((await first.json()) as { expiresAt: string }).expiresAt).toBe(
      "2026-01-02T00:00:00.000Z",
    );
    expect((await h.db.select().from(apiTokens)).length).toBe(1);
  });

  it("rejects an invalid expiry before a token row or idempotency claim", async () => {
    h = createTestDb();
    const response = await call(h.db)("/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "invalid-expiry-key" },
      body: JSON.stringify({ name: "expiry", scopes: ["read"], expiresAt: "not-a-date" }),
    });

    expect(response.status).toBe(400);
    expect(await h.db.select().from(apiTokens)).toHaveLength(0);
    expect(await h.db.select().from(idempotencyRecords)).toHaveLength(0);
  });

  it("conflicts on a changed token request, while requests without a key remain independent", async () => {
    h = createTestDb();
    const keyed = call(h.db);
    expect(
      (
        await keyed("/tokens", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": IDEMPOTENCY_KEY },
          body: JSON.stringify({ name: "one", scopes: ["read"] }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await keyed("/tokens", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": IDEMPOTENCY_KEY },
          body: JSON.stringify({ name: "two", scopes: ["read"] }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await keyed("/tokens", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "three", scopes: ["read"] }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await keyed("/tokens", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "four", scopes: ["read"] }),
        })
      ).status,
    ).toBe(201);
    expect((await h.db.select().from(apiTokens)).length).toBe(3);
  });

  it("requires idempotency encryption before minting a token", async () => {
    h = createTestDb();
    const response = await call(h.db, null)("/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": IDEMPOTENCY_KEY },
      body: JSON.stringify({ name: "CI", scopes: ["read"] }),
    });
    expect(response.status).toBe(503);
    expect((await h.db.select().from(apiTokens)).length).toBe(0);
  });

  it("enforces UTF-8 byte caps for token fields", async () => {
    h = createTestDb();
    const request = call(h.db);
    expect(
      (
        await request("/tokens", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "é".repeat(100),
            principalId: "é".repeat(127) + "a",
            scopes: ["read"],
          }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await request("/tokens", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "é".repeat(101), scopes: ["read"] }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/tokens", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "ok", principalId: "é".repeat(128), scopes: ["read"] }),
        })
      ).status,
    ).toBe(400);
  });
});

describe("GET /v1/tokens", () => {
  it("lists tokens without secret or hash", async () => {
    h = createTestDb();
    h.db
      .insert(apiTokens)
      .values({
        id: "tok_l",
        lookupId: "lookuplist01",
        tokenHash: "a".repeat(64),
        name: "n",
        scopes: '["read"]',
      })
      .run();
    const res = await call(h.db)("/tokens");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("a".repeat(64)); // no hash leak
    const body = JSON.parse(text) as { tokens: Array<{ id: string }> };
    expect(body.tokens.map((t) => t.id)).toContain("tok_l");
  });
});

describe("GET /v1/tokens/:id", () => {
  it("returns the row via toPublicRow without leaking the hash", async () => {
    h = createTestDb();
    h.db
      .insert(apiTokens)
      .values({
        id: "tok_d",
        lookupId: "lookupdetail",
        tokenHash: "b".repeat(64),
        name: "n",
        scopes: '["read"]',
      })
      .run();
    const res = await call(h.db)("/tokens/tok_d");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("b".repeat(64)); // no hash leak
    const body = JSON.parse(text) as { id: string; scopes: string[] };
    expect(body.id).toBe("tok_d");
    expect(body.scopes).toEqual(["read"]);
  });

  it("404 for unknown id", async () => {
    h = createTestDb();
    const res = await call(h.db)("/tokens/tok_missing");
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/tokens/:id/revoke", () => {
  it("flips active to false and sets revoked_at", async () => {
    h = createTestDb();
    h.db
      .insert(apiTokens)
      .values({
        id: "tok_r",
        lookupId: "lookuprevoke",
        tokenHash: "a".repeat(64),
        name: "n",
        scopes: '["read"]',
      })
      .run();
    const res = await call(h.db)("/tokens/tok_r/revoke", { method: "POST" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("a".repeat(64)); // no hash leak
    const row = h.db.select().from(apiTokens).where(eq(apiTokens.id, "tok_r")).get();
    expect(row?.active).toBe(false);
    expect(row?.revokedAt).toBeTruthy();
  });

  it("404 for unknown id", async () => {
    h = createTestDb();
    const res = await call(h.db)("/tokens/tok_missing/revoke", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /v1/tokens/:id", () => {
  it("edits scopes", async () => {
    h = createTestDb();
    h.db
      .insert(apiTokens)
      .values({
        id: "tok_p",
        lookupId: "lookuppatch1",
        tokenHash: "a".repeat(64),
        name: "n",
        scopes: '["read"]',
      })
      .run();
    const res = await call(h.db)("/tokens/tok_p", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["read", "write"] }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("a".repeat(64)); // no hash leak
    const row = h.db.select().from(apiTokens).where(eq(apiTokens.id, "tok_p")).get();
    expect(JSON.parse(row!.scopes)).toEqual(["read", "write"]);
  });

  it("404 for unknown id", async () => {
    h = createTestDb();
    const res = await call(h.db)("/tokens/tok_missing", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["read"] }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/tokens/me", () => {
  // Helper that injects a specific identity, mirroring how the real middleware
  // attaches `auth` to the context.
  function callAs(db: TestDatabase["db"], auth: AuthContext) {
    const a = new Hono<{ Variables: { auth?: AuthContext } }>();
    a.use("*", async (c, next) => {
      c.set("auth", auth);
      await next();
    });
    a.route("/", apiTokenRoutes);
    return (path: string) => a.request(path, {}, { DB: db });
  }

  it("returns synthetic root identity for the static key", async () => {
    h = createTestDb();
    const res = await callAs(h.db, { kind: "root", scopes: ["*"] })("/tokens/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; name: string; scopes: string[] };
    expect(body.kind).toBe("root");
    expect(body.name).toBe("root");
    expect(body.scopes).toEqual(["*"]);
  });

  it("returns the token's identity (name + scopes) without leaking the hash", async () => {
    h = createTestDb();
    h.db
      .insert(apiTokens)
      .values({
        id: "tok_me",
        lookupId: "lookupme0001",
        tokenHash: "c".repeat(64),
        name: "laptop",
        scopes: '["read","write"]',
        principalType: "user",
      })
      .run();
    const res = await callAs(h.db, { kind: "token", tokenId: "tok_me", scopes: ["read", "write"] })(
      "/tokens/me",
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("c".repeat(64)); // no hash leak
    const body = JSON.parse(text) as {
      kind: string;
      name: string;
      scopes: string[];
      principalType: string;
    };
    expect(body.kind).toBe("token");
    expect(body.name).toBe("laptop");
    expect(body.scopes).toEqual(["read", "write"]);
    expect(body.principalType).toBe("user");
  });

  it("401 when the token's row no longer exists", async () => {
    h = createTestDb();
    const res = await callAs(h.db, { kind: "token", tokenId: "tok_gone", scopes: ["read"] })(
      "/tokens/me",
    );
    expect(res.status).toBe(401);
  });

  it("returns scopes for a relu_ user-key identity without a DB lookup (no 401)", async () => {
    h = createTestDb();
    // A relu_ identity has no api_tokens row; the handler must NOT 401 on it.
    const res = await callAs(h.db, {
      kind: "token",
      tokenId: "relu_someUserKeyId",
      scopes: ["read", "write"],
    })("/tokens/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      scopes: string[];
      principalType: string;
    };
    expect(body.kind).toBe("token");
    expect(body.scopes).toEqual(["read", "write"]);
    expect(body.principalType).toBe("user");
  });
});
