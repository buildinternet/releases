import { describe, it, expect } from "bun:test";
import { organizations, products, productsActive } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";
import { createTestDb } from "./setup";

describe("products.avatar_url", () => {
  it("round-trips on the base table and surfaces through products_active", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_a", name: "Acme", slug: "acme" });
    await db.insert(products).values({
      id: "prod_a",
      name: "App",
      slug: "app",
      orgId: "org_a",
      avatarUrl: "https://cdn.example/icon.png",
    });

    const [viaView] = await db
      .select({ avatarUrl: productsActive.avatarUrl })
      .from(productsActive)
      .where(eq(productsActive.id, "prod_a"));
    expect(viaView?.avatarUrl).toBe("https://cdn.example/icon.png");
  });
});
