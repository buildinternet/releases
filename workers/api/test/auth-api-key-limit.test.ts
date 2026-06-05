import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "./setup";
import { createAuth } from "../src/auth/index.js";
import { apikey } from "../src/db/schema-auth.js";
import { USER_API_KEY_MAX_ACTIVE, countActiveUserKeys } from "../src/auth/api-key-limit.js";
import type { AuthAuditFields } from "../src/auth/audit.js";

// A capturing audit sink: records (level, fields) pairs for assertions.
function captureSink() {
  const events: Array<{ level: "info" | "warn"; fields: AuthAuditFields }> = [];
  const sink = (level: "info" | "warn", fields: AuthAuditFields) => {
    events.push({ level, fields });
  };
  return { events, sink };
}

// Insert an apikey row directly (bypassing Better Auth) so we can pin the
// enabled/expiresAt edge cases the count predicate must get right.
function insertKey(
  db: ReturnType<typeof createTestDb>,
  row: {
    id: string;
    referenceId: string;
    enabled?: boolean | null;
    expiresAt?: Date | null;
  },
) {
  const now = new Date();
  return db
    .insert(apikey)
    .values({
      id: row.id,
      key: `hash-${row.id}`,
      name: row.id,
      referenceId: row.referenceId,
      enabled: row.enabled ?? null,
      expiresAt: row.expiresAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

// ── countActiveUserKeys (the cap predicate) ──

describe("countActiveUserKeys", () => {
  const future = new Date(Date.now() + 60 * 60 * 1000);
  const past = new Date(Date.now() - 60 * 60 * 1000);

  it("counts enabled=true and enabled=null (null means enabled) keys", () => {
    const db = createTestDb();
    insertKey(db, { id: "k1", referenceId: "u1", enabled: true });
    insertKey(db, { id: "k2", referenceId: "u1", enabled: null });
    expect(countActiveUserKeys(db, "u1")).resolves.toBe(2);
  });

  it("excludes disabled keys (enabled=false)", () => {
    const db = createTestDb();
    insertKey(db, { id: "k1", referenceId: "u1", enabled: true });
    insertKey(db, { id: "k2", referenceId: "u1", enabled: false });
    expect(countActiveUserKeys(db, "u1")).resolves.toBe(1);
  });

  it("excludes expired keys but counts future-dated and null-expiry ones", () => {
    const db = createTestDb();
    insertKey(db, { id: "k1", referenceId: "u1", expiresAt: past });
    insertKey(db, { id: "k2", referenceId: "u1", expiresAt: future });
    insertKey(db, { id: "k3", referenceId: "u1", expiresAt: null });
    expect(countActiveUserKeys(db, "u1")).resolves.toBe(2);
  });

  it("scopes the count to the owning user", () => {
    const db = createTestDb();
    insertKey(db, { id: "k1", referenceId: "u1" });
    insertKey(db, { id: "k2", referenceId: "u2" });
    insertKey(db, { id: "k3", referenceId: "u2" });
    expect(countActiveUserKeys(db, "u2")).resolves.toBe(2);
  });
});

// ── Cap + audit over the real Better Auth apiKey plugin ──
// createAuth registers apiKey() when USER_API_KEYS_ENABLED is on; we drive its
// real createApiKey/deleteApiKey endpoints (server calls — no headers) so the
// before/after hooks run exactly as they do for our /v1/api-keys route.

const ENV = {
  BETTER_AUTH_URL: "https://api.releases.localhost",
  BETTER_AUTH_SECRET: "test-secret-do-not-use-in-prod-0123456789",
  USER_API_KEYS_ENABLED: "true",
} as const;

// The two apiKey endpoints we drive as server calls. The plugin is flag-gated so
// betterAuth's inferred `api` type omits them; assert the slice we use.
interface ApiKeyApi {
  createApiKey: (a: {
    body: { name: string; userId: string; permissions: Record<string, string[]> };
  }) => Promise<{ id: string }>;
}

async function buildAuth() {
  const db = createTestDb();
  const { events, sink } = captureSink();
  const auth = await createAuth(ENV as never, undefined, {
    db,
    sendEmail: () => {},
    audit: sink,
  });
  return { auth, db, events, api: auth.api as unknown as ApiKeyApi };
}

describe("user API key cap (before-hook) + audit (after-hook)", () => {
  it("allows up to the cap, then rejects further creates with API_KEY_LIMIT_REACHED", async () => {
    const { api } = await buildAuth();

    for (let i = 0; i < USER_API_KEY_MAX_ACTIVE; i++) {
      const created = await api.createApiKey({
        body: { name: `key-${i}`, userId: "owner-1", permissions: { api: ["read"] } },
      });
      expect(created.id).toBeTruthy();
    }

    let threw: unknown;
    try {
      await api.createApiKey({
        body: { name: "over", userId: "owner-1", permissions: { api: ["read"] } },
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeTruthy();
    expect((threw as { body?: { code?: string } }).body?.code).toBe("API_KEY_LIMIT_REACHED");
  });

  it("counts per-user — a second user is unaffected by the first user's keys", async () => {
    const { api } = await buildAuth();
    for (let i = 0; i < USER_API_KEY_MAX_ACTIVE; i++) {
      await api.createApiKey({
        body: { name: `a-${i}`, userId: "owner-A", permissions: { api: ["read"] } },
      });
    }
    // owner-B is at zero → first create still succeeds.
    const created = await api.createApiKey({
      body: { name: "b-0", userId: "owner-B", permissions: { api: ["read"] } },
    });
    expect(created.id).toBeTruthy();
  });

  it("frees a slot after a delete, letting a new create succeed", async () => {
    const { api, db } = await buildAuth();
    const ids: string[] = [];
    for (let i = 0; i < USER_API_KEY_MAX_ACTIVE; i++) {
      const c = await api.createApiKey({
        body: { name: `k-${i}`, userId: "owner-2", permissions: { api: ["read"] } },
      });
      ids.push(c.id);
    }
    // At cap → next create rejects.
    await expect(
      api.createApiKey({ body: { name: "x", userId: "owner-2", permissions: { api: ["read"] } } }),
    ).rejects.toBeTruthy();
    // Revoke one the way our /v1/api-keys/:id route does — a hard row delete —
    // then a create fits again.
    await db.delete(apikey).where(eq(apikey.id, ids[0])).run();
    const created = await api.createApiKey({
      body: { name: "after-delete", userId: "owner-2", permissions: { api: ["read"] } },
    });
    expect(created.id).toBeTruthy();
  });

  it("emits an api-key-created audit event with the owning userId + keyId", async () => {
    const { api, events } = await buildAuth();
    const created = await api.createApiKey({
      body: { name: "audited", userId: "owner-3", permissions: { api: ["read"] } },
    });
    const ev = events.find((e) => e.fields.event === "api-key-created");
    expect(ev).toBeTruthy();
    expect(ev?.fields.userId).toBe("owner-3");
    expect(ev?.fields.keyId).toBe(created.id);
  });

  it("does NOT emit a created audit when the create is rejected by the cap", async () => {
    const { api, events } = await buildAuth();
    for (let i = 0; i < USER_API_KEY_MAX_ACTIVE; i++) {
      await api.createApiKey({
        body: { name: `k-${i}`, userId: "owner-4", permissions: { api: ["read"] } },
      });
    }
    const before = events.filter((e) => e.fields.event === "api-key-created").length;
    await expect(
      api.createApiKey({
        body: { name: "over", userId: "owner-4", permissions: { api: ["read"] } },
      }),
    ).rejects.toBeTruthy();
    const after = events.filter((e) => e.fields.event === "api-key-created").length;
    expect(after).toBe(before); // no new created-event for the rejected attempt
  });
});
