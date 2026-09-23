import { describe, it, expect } from "bun:test";
import { organizations, products, sources } from "@buildinternet/releases-core/schema";
import { createTestDb, createTestApp } from "./setup";
import { productRoutes } from "../src/routes/products.js";

describe("GET product detail — app source fields", () => {
  it("returns metadata + kind on its sources", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_a", name: "Acme", slug: "acme" });
    await db.insert(products).values({ id: "prod_a", name: "App", slug: "app", orgId: "org_a" });
    await db.insert(sources).values({
      id: "src_a",
      name: "App by Acme",
      slug: "app-ios",
      type: "appstore",
      url: "https://apps.apple.com/us/app/id1",
      orgId: "org_a",
      productId: "prod_a",
      kind: "mobile",
      metadata: JSON.stringify({ appStore: { platform: "ios", artworkUrl: "https://cdn/x.png" } }),
    });
    const fetch = createTestApp(db, [productRoutes], { env: {} });

    const res = await fetch(new Request("https://x.test/v1/products/prod_a"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sources: { kind?: string; metadata?: string }[] };
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]!.kind).toBe("mobile");
    expect(JSON.parse(body.sources[0]!.metadata!).appStore.platform).toBe("ios");
  });
});
