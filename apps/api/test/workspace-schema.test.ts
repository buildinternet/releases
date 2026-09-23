import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "./setup";
import { authOrganization, authMember, user } from "../src/db/schema-auth.js";

describe("workspaces schema + migration", () => {
  it("creates organization + member rows and reads them back", async () => {
    const db = createTestDb();
    await db.insert(user).values({ id: "u_1", name: "Ann", email: "ann@example.com" });
    await db
      .insert(authOrganization)
      .values({ id: "org_1", name: "Ann's Workspace", slug: "ws-u_1" });
    await db
      .insert(authMember)
      .values({ id: "mem_1", organizationId: "org_1", userId: "u_1", role: "owner" });

    const orgs = await db.select().from(authOrganization).where(eq(authOrganization.id, "org_1"));
    expect(orgs[0]?.slug).toBe("ws-u_1");
    const members = await db.select().from(authMember).where(eq(authMember.userId, "u_1"));
    expect(members[0]?.role).toBe("owner");
  });

  it("adds the active/last-active organization columns", async () => {
    const db = createTestDb();
    await db.insert(user).values({
      id: "u_2",
      name: "Bea",
      email: "bea@example.com",
      lastActiveOrganizationId: "org_x",
    });
    const rows = await db.select().from(user).where(eq(user.id, "u_2"));
    expect(rows[0]?.lastActiveOrganizationId).toBe("org_x");
  });
});
