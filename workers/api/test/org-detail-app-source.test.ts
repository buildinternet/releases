import { describe, it, expect } from "bun:test";
import { organizations, products, sources } from "@buildinternet/releases-core/schema";
import { createTestDb, createTestApp } from "./setup";
import { orgRoutes } from "../src/routes/orgs.js";

describe("GET org detail — app source metadata", () => {
  it("returns metadata on its sources so the web can render the app icon", async () => {
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
    const fetch = createTestApp(db, [orgRoutes], { env: {} });

    const res = await fetch(new Request("https://x.test/v1/orgs/acme"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sources: { slug: string; metadata?: string | null }[] };
    const src = body.sources.find((s) => s.slug === "app-ios");
    expect(src).toBeDefined();
    expect(JSON.parse(src!.metadata!).appStore.artworkUrl).toBe("https://cdn/x.png");
  });
});
