import { describe, it, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { apikey } from "../src/db/schema-auth.js";
import { scopeToPermissions } from "../src/auth/api-key-scope.js";
import { apiTokenRoutes } from "../src/routes/api-tokens.js";
import type { AuthContext } from "../src/middleware/auth.js";
import type { Env } from "../src/index.js";

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

/** Mount /tokens with an injected identity (skips the verify path). */
function appWithAuth(auth: AuthContext) {
  const a = new Hono<Env>();
  a.use("*", (c, next) => {
    c.set("auth", auth);
    return next();
  });
  a.route("/", apiTokenRoutes);
  return a;
}

function seedKey(db: TestDatabase["db"], id: string, referenceId: string) {
  db.insert(apikey)
    .values({
      id,
      key: `hash-${id}`,
      referenceId,
      name: id,
      permissions: JSON.stringify(scopeToPermissions("read")),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
}

const del = (auth: AuthContext, db: TestDatabase["db"]) =>
  appWithAuth(auth).request("/tokens/me", { method: "DELETE" }, { DB: db });

describe("DELETE /tokens/me (user key self-revoke)", () => {
  it("deletes only the presenting relu_ key", async () => {
    h = createTestDb();
    seedKey(h.db, "ak_self", "user_1");
    seedKey(h.db, "ak_other", "user_1");

    const res = await del({ kind: "token", tokenId: "relu_ak_self", scopes: ["read"] }, h.db);
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ success: true });

    const left = h.db.select({ id: apikey.id }).from(apikey).all();
    expect(left.map((r) => r.id)).toEqual(["ak_other"]);
  });

  it("answers 401 when the key is already gone", async () => {
    h = createTestDb();
    const res = await del({ kind: "token", tokenId: "relu_ak_missing", scopes: ["read"] }, h.db);
    expect(res.status).toBe(401);
  });

  it("refuses a machine token without touching user keys", async () => {
    h = createTestDb();
    seedKey(h.db, "ak_keep", "user_1");
    const res = await del({ kind: "token", tokenId: "tok_abc", scopes: ["admin"] }, h.db);
    expect(res.status).toBe(400);
    expect(h.db.select().from(apikey).where(eq(apikey.id, "ak_keep")).all()).toHaveLength(1);
  });

  it("refuses the root key and OAuth principals", async () => {
    h = createTestDb();
    expect((await del({ kind: "root", scopes: ["admin"] }, h.db)).status).toBe(400);
    expect(
      (await del({ kind: "token", tokenId: "oauth_user_1", scopes: ["read"] }, h.db)).status,
    ).toBe(400);
  });
});
