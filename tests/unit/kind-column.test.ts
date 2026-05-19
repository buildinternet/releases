import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { organizations, products, sources } from "@buildinternet/releases-core/schema";
import { applyMigrations } from "../db-helper.js";

describe("products.kind / sources.kind column", () => {
  test("kind column accepts a valid enum value on products", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    await applyMigrations(sqlite);
    await db.insert(organizations).values({
      id: "org_seed",
      name: "Seed Org",
      slug: "seed-org",
      discovery: "curated",
    });
    await db.insert(products).values({
      id: "prod_test1",
      name: "Test",
      slug: "test",
      orgId: "org_seed",
      kind: "sdk",
    });
    const row = await db.select().from(products).where(eq(products.id, "prod_test1")).get();
    expect(row?.kind).toBe("sdk");
  });

  test("kind column defaults to null on sources when omitted", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    await applyMigrations(sqlite);
    await db.insert(organizations).values({
      id: "org_seed",
      name: "Seed Org",
      slug: "seed-org",
      discovery: "curated",
    });
    await db.insert(sources).values({
      id: "src_test1",
      name: "Test",
      slug: "test",
      url: "https://example.com",
      type: "feed",
      orgId: "org_seed",
    });
    const row = await db.select().from(sources).where(eq(sources.id, "src_test1")).get();
    expect(row?.kind).toBe(null);
  });
});
