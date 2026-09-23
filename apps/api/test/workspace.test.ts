import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "./setup";
import {
  deriveWorkspaceName,
  personalWorkspaceSlug,
  ensureActiveWorkspace,
  isOrgOwnerOrAdmin,
} from "../src/auth/workspace.js";
import { authOrganization, authMember, user } from "../src/db/schema-auth.js";

describe("deriveWorkspaceName", () => {
  it("uses the first token of a multi-word name", () => {
    expect(deriveWorkspaceName({ name: "Ann Smith", email: "ann@example.com" })).toBe(
      "Ann's Workspace",
    );
  });
  it("uses a single-word name as-is", () => {
    expect(deriveWorkspaceName({ name: "Ann", email: "ann@example.com" })).toBe("Ann's Workspace");
  });
  it("falls back to the email local-part when name is empty", () => {
    expect(deriveWorkspaceName({ name: "", email: "bea.long@example.com" })).toBe(
      "bea.long's Workspace",
    );
  });
  it("falls back to a generic name when neither is present", () => {
    expect(deriveWorkspaceName(null)).toBe("Personal Workspace");
    expect(deriveWorkspaceName({ name: "   ", email: null })).toBe("Personal Workspace");
  });
});

describe("personalWorkspaceSlug", () => {
  it("is deterministic and namespaced by user id", () => {
    expect(personalWorkspaceSlug("u_abc123")).toBe("ws-u_abc123");
    expect(personalWorkspaceSlug("u_abc123")).toBe(personalWorkspaceSlug("u_abc123"));
  });
  it("differs per user", () => {
    expect(personalWorkspaceSlug("u_a")).not.toBe(personalWorkspaceSlug("u_b"));
  });
});

describe("ensureActiveWorkspace", () => {
  it("creates a personal workspace for a user with no memberships", async () => {
    const db = createTestDb();
    await db.insert(user).values({ id: "u_1", name: "Ann Smith", email: "ann@example.com" });
    const orgId = await ensureActiveWorkspace(db, "u_1");
    expect(orgId).toBeTruthy();

    const orgs = await db.select().from(authOrganization).where(eq(authOrganization.id, orgId!));
    expect(orgs[0]?.name).toBe("Ann's Workspace");
    expect(orgs[0]?.slug).toBe("ws-u_1");
    const members = await db.select().from(authMember).where(eq(authMember.userId, "u_1"));
    expect(members).toHaveLength(1);
    expect(members[0]?.role).toBe("owner");
    expect(members[0]?.organizationId).toBe(orgId!);
  });

  it("is idempotent — a second call returns the same workspace and does not duplicate", async () => {
    const db = createTestDb();
    await db.insert(user).values({ id: "u_1", name: "Ann", email: "ann@example.com" });
    const first = await ensureActiveWorkspace(db, "u_1");
    const second = await ensureActiveWorkspace(db, "u_1");
    expect(second).toBe(first);
    const members = await db.select().from(authMember).where(eq(authMember.userId, "u_1"));
    expect(members).toHaveLength(1);
  });

  it("adopts an existing workspace when the deterministic slug already exists (race)", async () => {
    const db = createTestDb();
    await db.insert(user).values({ id: "u_1", name: "Ann", email: "ann@example.com" });
    // Simulate the race winner: an org with the deterministic slug + the owner member.
    await db
      .insert(authOrganization)
      .values({ id: "org_win", name: "Ann's Workspace", slug: "ws-u_1" });
    await db
      .insert(authMember)
      .values({ id: "mem_win", organizationId: "org_win", userId: "u_1", role: "owner" });

    const orgId = await ensureActiveWorkspace(db, "u_1");
    expect(orgId).toBe("org_win");
    const orgs = await db
      .select()
      .from(authOrganization)
      .where(eq(authOrganization.slug, "ws-u_1"));
    expect(orgs).toHaveLength(1); // no duplicate org created
  });

  it("prefers last_active_organization_id when the user has multiple memberships", async () => {
    const db = createTestDb();
    await db.insert(user).values({
      id: "u_1",
      name: "Ann",
      email: "ann@example.com",
      lastActiveOrganizationId: "org_b",
    });
    await db.insert(authOrganization).values({ id: "org_a", name: "A", slug: "a" });
    await db.insert(authOrganization).values({ id: "org_b", name: "B", slug: "b" });
    await db
      .insert(authMember)
      .values({ id: "m_a", organizationId: "org_a", userId: "u_1", role: "owner" });
    await db
      .insert(authMember)
      .values({ id: "m_b", organizationId: "org_b", userId: "u_1", role: "member" });

    expect(await ensureActiveWorkspace(db, "u_1")).toBe("org_b");
  });

  it("returns null and does not throw when the user row is missing", async () => {
    const db = createTestDb();
    const orgId = await ensureActiveWorkspace(db, "u_ghost");
    expect(orgId).toBeNull();
  });
});

describe("isOrgOwnerOrAdmin", () => {
  async function seed(db: ReturnType<typeof createTestDb>) {
    await db.insert(user).values({ id: "owner", name: "O", email: "o@example.com" });
    await db.insert(user).values({ id: "memb", name: "M", email: "m@example.com" });
    await db.insert(user).values({ id: "adm", name: "A", email: "a@example.com" });
    await db.insert(authOrganization).values({ id: "org_1", name: "Org", slug: "org" });
    await db
      .insert(authMember)
      .values({ id: "m1", organizationId: "org_1", userId: "owner", role: "owner" });
    await db
      .insert(authMember)
      .values({ id: "m2", organizationId: "org_1", userId: "memb", role: "member" });
    await db
      .insert(authMember)
      .values({ id: "m3", organizationId: "org_1", userId: "adm", role: "admin" });
  }
  it("allows owner and admin, denies member and non-member", async () => {
    const db = createTestDb();
    await seed(db);
    expect(await isOrgOwnerOrAdmin(db, "owner", "org_1")).toBe(true);
    expect(await isOrgOwnerOrAdmin(db, "adm", "org_1")).toBe(true);
    expect(await isOrgOwnerOrAdmin(db, "memb", "org_1")).toBe(false);
    expect(await isOrgOwnerOrAdmin(db, "stranger", "org_1")).toBe(false);
  });
});
