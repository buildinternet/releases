import { describe, it, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { apikey } from "../../workers/api/src/db/schema-auth.js";
import { scopeToPermissions } from "../../workers/api/src/auth/api-key-scope.js";
import { apiTokenRoutes } from "../../workers/api/src/routes/api-tokens.js";
import type { Env } from "../../workers/api/src/index.js";

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

/** Mount /tokens with an injected relu_ token identity (skips the verify path). */
function appWithReluAuth(tokenId: string, scopes: string[]) {
  const a = new Hono<Env>();
  a.use("*", (c, next) => {
    c.set("auth", { kind: "token", tokenId, scopes });
    return next();
  });
  a.route("/", apiTokenRoutes);
  return a;
}

describe("GET /tokens/me enrichment for relu_ keys", () => {
  it("returns the real key name + Better Auth userId", async () => {
    h = createTestDb();
    h.db
      .insert(apikey)
      .values({
        id: "ak_1",
        key: "hash",
        referenceId: "user_9",
        name: "My CI Key",
        permissions: JSON.stringify(scopeToPermissions("read")),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const res = await appWithReluAuth("relu_ak_1", ["read"]).request(
      "/tokens/me",
      {},
      { DB: h.db },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe("My CI Key");
    expect(body.principalType).toBe("user");
    expect(body.principalId).toBe("user_9");
    // Dedicated owner userId for per-account rate-limit bucketing on MCP (#1729).
    expect(body.userId).toBe("user_9");
    expect(body.scopes).toEqual(["read"]);
  });

  it("falls back gracefully when the apikey row is gone", async () => {
    h = createTestDb();
    const res = await appWithReluAuth("relu_ak_missing", ["read"]).request(
      "/tokens/me",
      {},
      { DB: h.db },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe("user-api-key");
    expect(body.principalId).toBeNull();
    expect(body.userId).toBeNull();
  });
});
