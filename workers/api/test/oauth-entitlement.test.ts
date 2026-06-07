import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import {
  IDENTITY_SCOPES,
  ROLE_LADDER,
  entitledScopes,
  assertScopesEntitled,
  oauthAccessTokenClaims,
  consentScopeViolation,
} from "../src/auth/entitlement.js";
import { oauthAdminUserIds, createAuth } from "../src/auth/index.js";
import { createTestDb } from "./setup";
import { user as userTable, session as sessionTable } from "../src/db/schema-auth.js";

describe("entitledScopes", () => {
  it("gives identity + read to a plain user", () => {
    expect(entitledScopes("user")).toEqual([...IDENTITY_SCOPES, "read"]);
  });
  it("gives read+write to a curator", () => {
    expect(entitledScopes("curator")).toEqual([...IDENTITY_SCOPES, "read", "write"]);
  });
  it("gives the full ladder to an admin", () => {
    expect(entitledScopes("admin")).toEqual([...IDENTITY_SCOPES, "read", "write", "admin"]);
  });
  it("fails closed for null/unknown roles → read-only", () => {
    expect(entitledScopes(null)).toEqual([...IDENTITY_SCOPES, "read"]);
    expect(entitledScopes(undefined)).toEqual([...IDENTITY_SCOPES, "read"]);
    expect(entitledScopes("wizard")).toEqual([...IDENTITY_SCOPES, "read"]);
  });
  it("unions ladders for a comma-separated multi-role", () => {
    expect(entitledScopes("user,curator")).toEqual([...IDENTITY_SCOPES, "read", "write"]);
  });
  it("treats empty-string role as read-only (fail-closed)", () => {
    expect(entitledScopes("")).toEqual([...IDENTITY_SCOPES, "read"]);
  });
  it("an unknown role inside a multi-role string degrades to read-only for that token", () => {
    expect(entitledScopes("user,wizard")).toEqual([...IDENTITY_SCOPES, "read"]);
  });
});

describe("assertScopesEntitled", () => {
  it("passes when requested ⊆ entitled", () => {
    expect(() => assertScopesEntitled("curator", ["openid", "read", "write"])).not.toThrow();
  });
  it("throws when a user requests write", () => {
    expect(() => assertScopesEntitled("user", ["read", "write"])).toThrow(/write/);
  });
  it("allows identity scopes for everyone", () => {
    expect(() => assertScopesEntitled("user", [...IDENTITY_SCOPES])).not.toThrow();
  });
});

describe("oauthAccessTokenClaims", () => {
  it("stamps the role claim for a user-bound token", () => {
    expect(
      oauthAccessTokenClaims({ user: { role: "curator" }, scopes: ["read", "write"] }),
    ).toEqual({
      "https://releases.sh/role": "curator",
    });
  });
  it("defaults the role claim to user when role is absent", () => {
    expect(oauthAccessTokenClaims({ user: { role: null }, scopes: ["read"] })).toEqual({
      "https://releases.sh/role": "user",
    });
  });
  it("throws (fail-closed) when a user-bound token exceeds entitlement", () => {
    expect(() =>
      oauthAccessTokenClaims({ user: { role: "user" }, scopes: ["read", "admin"] }),
    ).toThrow();
  });
  it("skips the entitlement check for M2M tokens (user undefined)", () => {
    expect(oauthAccessTokenClaims({ scopes: ["read", "write", "admin"] })).toEqual({});
  });
  it("denies a deleted user (user null) beyond read", () => {
    expect(() => oauthAccessTokenClaims({ user: null, scopes: ["write"] })).toThrow();
  });
});

describe("consentScopeViolation", () => {
  it("flags a user granting write", () => {
    expect(consentScopeViolation("user", { accept: true, scope: "read write" })).toBe(true);
  });
  it("passes a curator granting read+write", () => {
    expect(consentScopeViolation("curator", { accept: true, scope: "openid read write" })).toBe(
      false,
    );
  });
  it("ignores deny submissions", () => {
    expect(consentScopeViolation("user", { accept: false, scope: "read write" })).toBe(false);
  });
  it("passes when scope is omitted (token backstop catches over-broad)", () => {
    expect(consentScopeViolation("user", { accept: true })).toBe(false);
  });
});

describe("admin-plugin schema", () => {
  it("user.role + ban fields round-trip through drizzle", async () => {
    const db = createTestDb();
    await db.insert(userTable).values({
      id: "u_1",
      name: "Curator",
      email: "curator@example.com",
      emailVerified: true,
      role: "curator",
      banned: false,
      banReason: "spam",
      banExpires: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const rows = await db.select().from(userTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("curator");
    expect(rows[0]?.banned).toBe(false);
    expect(rows[0]?.banReason).toBe("spam");
    expect(rows[0]?.banExpires).toBeInstanceOf(Date);
  });

  it("session.impersonatedBy column exists and round-trips", async () => {
    const db = createTestDb();
    await db.insert(userTable).values({
      id: "u_2",
      name: "U",
      email: "u2@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(sessionTable).values({
      id: "s_1",
      userId: "u_2",
      token: "tok_1",
      expiresAt: new Date(Date.now() + 3_600_000),
      impersonatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(sessionTable).values({
      id: "s_2",
      userId: "u_2",
      token: "tok_2",
      expiresAt: new Date(Date.now() + 3_600_000),
      impersonatedBy: "u_admin",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const nullRow = await db.select().from(sessionTable).where(eq(sessionTable.id, "s_1"));
    expect(nullRow[0]?.impersonatedBy ?? null).toBeNull();
    const adminRow = await db.select().from(sessionTable).where(eq(sessionTable.id, "s_2"));
    expect(adminRow[0]?.impersonatedBy).toBe("u_admin");
  });
});

describe("oauthAdminUserIds", () => {
  it("parses a comma-separated list, trimming blanks", () => {
    expect(oauthAdminUserIds({ OAUTH_ADMIN_USER_IDS: "u_1, u_2 ,, u_3" } as never)).toEqual([
      "u_1",
      "u_2",
      "u_3",
    ]);
  });
  it("returns [] when unset", () => {
    expect(oauthAdminUserIds({} as never)).toEqual([]);
  });
  it("returns [] for an empty string", () => {
    expect(oauthAdminUserIds({ OAUTH_ADMIN_USER_IDS: "" } as never)).toEqual([]);
  });
});

const wiringEnv = {
  BETTER_AUTH_URL: "https://api.releases.localhost",
  BETTER_AUTH_SECRET: "test-secret-do-not-use-in-prod-0123456789",
  WEB_BASE_URL: "https://releases.localhost",
} as never;

describe("admin plugin wiring", () => {
  it("registers the admin plugin", async () => {
    const auth = await createAuth(wiringEnv, undefined, {
      db: createTestDb(),
      sendEmail: () => {},
    });
    const ids = (auth.options.plugins ?? []).map((p: { id: string }) => p.id);
    expect(ids.includes("admin")).toBe(true);
  });
});

describe("consent gate + claims wiring", () => {
  it("registers a before-hook on the auth instance", async () => {
    const auth = await createAuth(wiringEnv, undefined, {
      db: createTestDb(),
      sendEmail: () => {},
    });
    expect(typeof auth.options.hooks?.before).toBe("function");
  });
});
