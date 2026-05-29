import { describe, it, expect } from "bun:test";
import { organizations, products, productsActive } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";
import { createTestDb, createTestApp } from "./setup";
import { productRoutes } from "../src/routes/products.js";
import { orgRoutes } from "../src/routes/orgs.js";

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

describe("GET /v1/products list surfaces avatarUrl", () => {
  it("includes avatarUrl in list items (e.g. an App Store app icon)", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_c", name: "Gamma", slug: "gamma" });
    await db.insert(products).values({
      id: "prod_c",
      name: "C",
      slug: "c",
      orgId: "org_c",
      avatarUrl: "https://cdn.example/c.png",
    });
    await db.insert(products).values({ id: "prod_d", name: "D", slug: "d", orgId: "org_c" });
    const fetch = createTestApp(db, [productRoutes], { env: {} });

    const res = await fetch(new Request("https://x.test/v1/products?orgId=org_c"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ slug: string; avatarUrl?: string | null }>;
    };
    const withIcon = body.items.find((p) => p.slug === "c");
    const withoutIcon = body.items.find((p) => p.slug === "d");
    expect(withIcon?.avatarUrl).toBe("https://cdn.example/c.png");
    // Present-but-null for products with no avatar — distinct from "field absent".
    expect(withoutIcon?.avatarUrl ?? null).toBeNull();
  });
});

describe("PATCH /v1/products avatarUrl", () => {
  it("sets and returns avatarUrl", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_b", name: "Beta", slug: "beta" });
    await db.insert(products).values({ id: "prod_b", name: "B", slug: "b", orgId: "org_b" });
    const fetch = createTestApp(db, [orgRoutes, productRoutes], { env: {} });

    const res = await fetch(
      new Request("https://x.test/v1/orgs/beta/products/b", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ avatarUrl: "https://cdn.example/b.png" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { avatarUrl?: string };
    expect(body.avatarUrl).toBe("https://cdn.example/b.png");
  });
});
