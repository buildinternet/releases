import { describe, it, expect, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { apikey, user } from "../../workers/api/src/db/schema-auth.js";
import { createAuth } from "../../workers/api/src/auth/index.js";
import { scopeToPermissions } from "../../workers/api/src/auth/api-key-scope.js";

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

describe("apikey table", () => {
  it("is created by the migration and is queryable", () => {
    h = createTestDb();
    // No rows yet, but the table must exist (migration applied by the harness).
    const rows = h.db.select().from(apikey).all();
    expect(rows).toEqual([]);
  });
});

// Minimal env: not production (top-level auth rate-limit stays off), feature ON,
// a fixed secret so Better Auth doesn't warn. Cast — tests don't need full Env.
function testEnv() {
  return {
    ENVIRONMENT: "test",
    BETTER_AUTH_SECRET: "test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    USER_API_KEYS_ENABLED: "true",
    // oxlint-disable-next-line no-explicit-any
  } as any;
}

describe("apiKey plugin create + verify", () => {
  it("creates a relu_ key and verifies it, returning api permissions", async () => {
    h = createTestDb();
    h.db
      .insert(user)
      .values({
        id: "user_test_1",
        name: "Test",
        email: "t@example.com",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const auth = await createAuth(testEnv(), undefined, { db: h.db });

    // apiKey() is flag-gated (conditional plugin registration), so betterAuth's
    // inferred `api` type doesn't statically expose these endpoints; assert the
    // shape the plugin provides at runtime when the flag is on.
    const api = auth.api as typeof auth.api & {
      createApiKey: (a: {
        body: { name: string; userId: string; permissions: Record<string, string[]> };
      }) => Promise<{ key: string }>;
      verifyApiKey: (a: { body: { key: string } }) => Promise<{
        valid: boolean;
        key?: { permissions?: Record<string, string[]> | null } | null;
      }>;
    };

    const created = await api.createApiKey({
      body: {
        name: "my key",
        userId: "user_test_1",
        permissions: scopeToPermissions("write"),
      },
    });
    expect(created.key).toMatch(/^relu_/);

    const verified = await api.verifyApiKey({ body: { key: created.key } });
    expect(verified.valid).toBe(true);
    expect(verified.key?.permissions).toEqual(scopeToPermissions("write"));
  });
});
