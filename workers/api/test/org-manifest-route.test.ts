// GET /v1/orgs/:slug/manifest — reconstructs an owner-declared releases.json v2
// domain manifest from the org's live products + sources (inverse of the
// well-known materializer). See workers/api/src/lib/well-known/export-manifest.ts.
import { describe, it, expect } from "bun:test";
import { organizations, products, sources } from "@buildinternet/releases-core/schema";
import { ReleasesJsonDomainSchema } from "@buildinternet/releases-api-types";
import { orgRoutes } from "../src/routes/orgs.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

const mkApp = (db: ReturnType<typeof mkDb>) => createTestApp(db, orgRoutes);

describe("GET /v1/orgs/:slug/manifest", () => {
  it("returns a valid v2 domain manifest reconstructed from live entities", async () => {
    const db = mkDb();
    await db
      .insert(organizations)
      .values({ id: "org_acme", slug: "acme", name: "Acme", category: "developer-tools" });
    await db
      .insert(products)
      .values({
        id: "prd_api",
        orgId: "org_acme",
        slug: "acme-api",
        name: "Acme API",
        kind: "platform",
      });
    await db.insert(sources).values([
      {
        id: "src_gh",
        orgId: "org_acme",
        productId: "prd_api",
        slug: "acme-api-gh",
        name: "Acme API GitHub",
        type: "github",
        url: "https://github.com/acme/api",
        isPrimary: true,
      },
      {
        id: "src_blog",
        orgId: "org_acme",
        slug: "acme-blog",
        name: "Acme Blog",
        type: "scrape",
        url: "https://acme.example/blog",
      },
    ]);

    const res = await mkApp(db)(new Request("https://x.test/v1/orgs/acme/manifest"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(ReleasesJsonDomainSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      version: 2,
      name: "Acme",
      category: "developer-tools",
      products: [
        {
          slug: "acme-api",
          kind: "platform",
          releases: [{ github: "acme/api", canonical: true }],
        },
      ],
      releases: [{ url: "https://acme.example/blog" }],
    });
  });

  it("404s for an unknown org", async () => {
    const db = mkDb();
    const res = await mkApp(db)(new Request("https://x.test/v1/orgs/nope/manifest"));
    expect(res.status).toBe(404);
  });
});
