import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { authMember, authOrganization, user } from "../src/db/schema-auth.js";
import { meHandlers } from "../src/routes/me.js";
import { meWorkspaceHandlers } from "../src/routes/me-workspaces.js";

let h: TestDatabase;

function app(opts: { userId?: string } = {}) {
  const a = new Hono();
  const userId = opts.userId;
  if (userId) {
    a.use("*", async (c, next) => {
      (c as unknown as { set: (k: string, v: unknown) => void }).set("session", {
        user: { id: userId, email: "t@e.com", name: "T" },
      });
      await next();
    });
  }
  a.route("/", meHandlers);
  a.route("/", meWorkspaceHandlers);
  const env = { DB: h.db } as unknown as Record<string, unknown>;
  return { a, env };
}

async function seedUser(id: string, lastActiveOrganizationId?: string) {
  await h.db.insert(user).values({
    id,
    name: id,
    email: `${id}@e.com`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastActiveOrganizationId: lastActiveOrganizationId ?? null,
  });
}

async function seedWorkspace(opts: {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
}) {
  await h.db.insert(authOrganization).values({
    id: opts.id,
    name: opts.name,
    slug: opts.slug,
    logo: opts.logo ?? null,
    createdAt: new Date(),
  });
}

async function seedMember(opts: {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
}) {
  await h.db.insert(authMember).values({
    id: opts.id,
    organizationId: opts.organizationId,
    userId: opts.userId,
    role: opts.role,
    createdAt: new Date(),
  });
}

beforeEach(async () => {
  h = createTestDb();
});

afterEach(() => h.cleanup());

describe("GET /me/workspaces", () => {
  it("returns 401 without a session", async () => {
    const { a, env } = app();
    const res = await a.request("/me/workspaces", {}, env);
    expect(res.status).toBe(401);
  });

  it("returns an empty list when the caller has no memberships", async () => {
    await seedUser("u1");
    const { a, env } = app({ userId: "u1" });
    const res = await a.request("/me/workspaces", {}, env);
    expect(res.status).toBe(200);
    expect((await res.json()) as { workspaces: unknown[] }).toEqual({ workspaces: [] });
  });

  it("lists the caller's workspaces with role and active, ordered by name", async () => {
    await seedUser("u1", "org_b");
    await seedWorkspace({ id: "org_a", name: "Ann's Workspace", slug: "ws-a", logo: "l.png" });
    await seedWorkspace({ id: "org_b", name: "Bea's Workspace", slug: "ws-b" });
    await seedMember({ id: "m1", organizationId: "org_a", userId: "u1", role: "owner" });
    await seedMember({ id: "m2", organizationId: "org_b", userId: "u1", role: "admin" });

    const { a, env } = app({ userId: "u1" });
    const res = await a.request("/me/workspaces", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: unknown[] };
    expect(body.workspaces).toHaveLength(2);
    expect(body.workspaces[0]).toMatchObject({
      id: "org_a",
      name: "Ann's Workspace",
      slug: "ws-a",
      logo: "l.png",
      role: "owner",
      active: false,
    });
    expect(body.workspaces[1]).toMatchObject({
      id: "org_b",
      name: "Bea's Workspace",
      slug: "ws-b",
      logo: null,
      role: "admin",
      active: true,
    });
  });

  it("never surfaces another user's workspaces", async () => {
    await seedUser("u1");
    await seedUser("u2");
    await seedWorkspace({ id: "org_1", name: "Only U2's", slug: "ws-1" });
    await seedMember({ id: "m1", organizationId: "org_1", userId: "u2", role: "owner" });

    const { a, env } = app({ userId: "u1" });
    const res = await a.request("/me/workspaces", {}, env);
    expect(res.status).toBe(200);
    expect((await res.json()) as { workspaces: unknown[] }).toEqual({ workspaces: [] });
  });

  it("normalizes an unexpected role value to member", async () => {
    await seedUser("u1");
    await seedWorkspace({ id: "org_1", name: "Weird Role Org", slug: "ws-weird" });
    await seedMember({ id: "m1", organizationId: "org_1", userId: "u1", role: "guest" });

    const { a, env } = app({ userId: "u1" });
    const res = await a.request("/me/workspaces", {}, env);
    const body = (await res.json()) as { workspaces: Array<{ role: string }> };
    expect(body.workspaces[0]?.role).toBe("member");
  });
});
