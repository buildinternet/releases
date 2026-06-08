import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { organizations, products } from "@buildinternet/releases-core/schema";
import { user } from "../src/db/schema-auth.js";
import {
  addFollow,
  removeFollow,
  listFollows,
  resolveFollowTarget,
} from "../src/queries/follows.js";

let h: TestDatabase;

beforeEach(async () => {
  h = createTestDb();
  await h.db.insert(user).values({
    id: "u1",
    name: "Test",
    email: "t@example.com",
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await h.db.insert(organizations).values({ id: "org_a", name: "Acme", slug: "acme" });
  await h.db
    .insert(products)
    .values({ id: "prd_a", name: "Widget", slug: "widget", orgId: "org_a" });
});

afterEach(() => h.cleanup());

describe("follows store", () => {
  it("adds a follow and lists it enriched", async () => {
    await addFollow(h.db, "u1", "org", "org_a");
    const rows = await listFollows(h.db, "u1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      targetType: "org",
      targetId: "org_a",
      name: "Acme",
      slug: "acme",
    });
  });

  it("is idempotent — re-following does not duplicate", async () => {
    await addFollow(h.db, "u1", "product", "prd_a");
    await addFollow(h.db, "u1", "product", "prd_a");
    const rows = await listFollows(h.db, "u1");
    expect(rows).toHaveLength(1);
  });

  it("removes a follow (idempotent)", async () => {
    await addFollow(h.db, "u1", "org", "org_a");
    await removeFollow(h.db, "u1", "org", "org_a");
    await removeFollow(h.db, "u1", "org", "org_a"); // no throw on second
    expect(await listFollows(h.db, "u1")).toHaveLength(0);
  });

  it("resolveFollowTarget returns the entity for a live org/product, null otherwise", async () => {
    expect(await resolveFollowTarget(h.db, "org", "org_a")).toMatchObject({ slug: "acme" });
    expect(await resolveFollowTarget(h.db, "product", "prd_a")).toMatchObject({ slug: "widget" });
    expect(await resolveFollowTarget(h.db, "org", "nope")).toBeNull();
  });

  it("list returns only the caller's follows", async () => {
    await h.db.insert(user).values({
      id: "u2",
      name: "Other",
      email: "o@example.com",
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await addFollow(h.db, "u1", "org", "org_a");
    await addFollow(h.db, "u2", "product", "prd_a");
    expect(await listFollows(h.db, "u1")).toHaveLength(1);
  });

  it("listFollows drops orphans — soft-deleting the target removes it from the list", async () => {
    await addFollow(h.db, "u1", "org", "org_a");
    expect(await listFollows(h.db, "u1")).toHaveLength(1);
    await h.db
      .update(organizations)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(organizations.id, "org_a"));
    expect(await listFollows(h.db, "u1")).toHaveLength(0);
  });
});
