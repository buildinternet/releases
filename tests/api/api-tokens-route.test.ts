import { describe, it, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { apiTokenRoutes } from "../../workers/api/src/routes/api-tokens.js";
import type { AuthContext } from "../../workers/api/src/middleware/auth.js";
import { apiTokens } from "@buildinternet/releases-core/schema";
import { parseApiToken, hashSecret } from "@buildinternet/releases-core/api-token";
import { eq } from "drizzle-orm";

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

function call(db: TestDatabase["db"]) {
  const a = new Hono<{ Variables: { auth?: AuthContext } }>();
  // Simulate the admin middleware having attached a root identity.
  a.use("*", async (c, next) => {
    c.set("auth", { kind: "root", scopes: ["*"] });
    await next();
  });
  a.route("/", apiTokenRoutes);
  return (path: string, init?: RequestInit) => a.request(path, init, { DB: db });
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
});
