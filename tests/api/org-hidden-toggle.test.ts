import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations } from "../db-helper";
import { organizations } from "@buildinternet/releases-core/schema";

describe("organizations.is_hidden column", () => {
  it("defaults to false and round-trips true", async () => {
    const sqlite = new Database(":memory:");
    applyMigrations(sqlite);
    const db = drizzle(sqlite);

    await db
      .insert(organizations)
      .values([
        { id: "org_default", slug: "default-org", name: "Default" },
        { id: "org_hidden", slug: "hidden-org", name: "Hidden", isHidden: true },
      ])
      .run();

    const [def] = await db.select().from(organizations).where(eq(organizations.id, "org_default"));
    const [hid] = await db.select().from(organizations).where(eq(organizations.id, "org_hidden"));

    expect(def.isHidden).toBe(false);
    expect(hid.isHidden).toBe(true);
  });
});
