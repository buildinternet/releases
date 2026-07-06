/**
 * Stub-tier orgs (#1947) are noindex thin pages — GET /v1/sitemap must not
 * list them (nor their products/sources).
 */
import { describe, it, expect } from "bun:test";
import { organizations } from "@buildinternet/releases-core/schema";
import { sitemapRoutes } from "../src/routes/sitemap.js";
import { createStubOrg } from "../src/lib/well-known/stub.js";
import { createTestDb, createTestApp } from "./setup";

describe("GET /v1/sitemap (stub exclusion)", () => {
  it("excludes stub orgs and includes tracked ones", async () => {
    const db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_tracked", name: "Tracked", slug: "tracked-co", tier: "tracked" });
    await createStubOrg(
      db as never,
      {
        name: "Stubby",
        slug: "stubby-co",
        domain: "stubby.com",
        locations: [{ feed: "https://stubby.com/f.xml" }],
      },
      { basis: "declared" },
    );

    const app = createTestApp(db, sitemapRoutes);
    const res = await app(new Request("https://x/v1/sitemap"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orgs: { slug: string }[] };
    const slugs = body.orgs.map((o) => o.slug);
    expect(slugs).toContain("tracked-co");
    expect(slugs).not.toContain("stubby-co");
  });
});
