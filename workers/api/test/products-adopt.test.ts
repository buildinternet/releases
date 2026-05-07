/**
 * `POST /v1/products/adopt` — covers both the new-product and `mergeInto`
 * branches. The mergeInto branch (#794 item 5) folds a source org into an
 * existing product instead of creating a new one — used when an operator
 * has already pre-created a product shell.
 */
import { describe, it, expect } from "bun:test";
import { createTestDb } from "../../../tests/db-helper";
import { eq } from "drizzle-orm";
import { organizations, products, sources } from "@buildinternet/releases-core/schema";
import { Hono } from "hono";
import { productRoutes } from "../src/routes/products.js";

function mkDb() {
  return createTestDb().db;
}

function mkApp(db: ReturnType<typeof mkDb>) {
  const fakeEnv = { DB: db };
  const fakeCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", productRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, fakeEnv, fakeCtx);
}

async function seedTwoOrgs(db: ReturnType<typeof mkDb>) {
  await db.insert(organizations).values([
    { id: "org_target", slug: "target-org", name: "Target", category: "cloud" },
    { id: "org_source", slug: "source-org", name: "Source", category: "cloud" },
  ]);
  await db.insert(sources).values({
    id: "src_one",
    orgId: "org_source",
    slug: "src-one",
    name: "One",
    type: "feed",
    url: "https://x/1",
  });
}

describe("POST /v1/products/adopt", () => {
  it("creates a new product (default branch)", async () => {
    const db = mkDb();
    await seedTwoOrgs(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("http://x/v1/products/adopt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceOrgSlug: "source-org", targetOrgSlug: "target-org" }),
      }),
    );
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.product).toBeTruthy();
    expect(json.product.orgId).toBe("org_target");
    expect(json.mergedInto).toBeUndefined();
    expect(json.sourcesMoved).toBe(1);
    expect(json.sourceOrgDeleted).toBe("source-org");

    const [movedSrc] = await db.select().from(sources).where(eq(sources.id, "src_one"));
    expect(movedSrc.orgId).toBe("org_target");
    expect(movedSrc.productId).toBe(json.product.id);
  });

  it("mergeInto reuses an existing product instead of creating one", async () => {
    const db = mkDb();
    await seedTwoOrgs(db);
    await db.insert(products).values({
      id: "prod_existing",
      orgId: "org_target",
      slug: "existing-shell",
      name: "Existing",
    });
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("http://x/v1/products/adopt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceOrgSlug: "source-org",
          targetOrgSlug: "target-org",
          mergeInto: "existing-shell",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.product.id).toBe("prod_existing");
    expect(json.mergedInto).toBe("existing-shell");
    expect(json.sourcesMoved).toBe(1);

    const allProducts = await db.select().from(products);
    expect(allProducts.length).toBe(1);
    expect(allProducts[0].id).toBe("prod_existing");
  });

  it("mergeInto + slug is rejected with 400", async () => {
    const db = mkDb();
    await seedTwoOrgs(db);
    await db.insert(products).values({
      id: "prod_existing",
      orgId: "org_target",
      slug: "existing-shell",
      name: "Existing",
    });
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("http://x/v1/products/adopt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceOrgSlug: "source-org",
          targetOrgSlug: "target-org",
          mergeInto: "existing-shell",
          slug: "ignored",
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("mergeInto by slug only resolves products under the target org (404 otherwise)", async () => {
    const db = mkDb();
    await seedTwoOrgs(db);
    await db
      .insert(organizations)
      .values({ id: "org_other", slug: "other-org", name: "Other", category: "cloud" });
    await db
      .insert(products)
      .values({ id: "prod_other", orgId: "org_other", slug: "other-shell", name: "Other Shell" });
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("http://x/v1/products/adopt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceOrgSlug: "source-org",
          targetOrgSlug: "target-org",
          mergeInto: "other-shell",
        }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("mergeInto by slug picks the target org's product when slugs collide across orgs", async () => {
    const db = mkDb();
    await seedTwoOrgs(db);
    await db
      .insert(organizations)
      .values({ id: "org_other", slug: "other-org", name: "Other", category: "cloud" });
    // Same slug in two orgs — must resolve to the one under the target.
    await db.insert(products).values([
      { id: "prod_other_shared", orgId: "org_other", slug: "shared-shell", name: "Other" },
      { id: "prod_target_shared", orgId: "org_target", slug: "shared-shell", name: "Target" },
    ]);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("http://x/v1/products/adopt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceOrgSlug: "source-org",
          targetOrgSlug: "target-org",
          mergeInto: "shared-shell",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.product.id).toBe("prod_target_shared");
    expect(json.mergedInto).toBe("shared-shell");
  });

  it("mergeInto accepts a prod_ ID directly", async () => {
    const db = mkDb();
    await seedTwoOrgs(db);
    await db.insert(products).values({
      id: "prod_existing",
      orgId: "org_target",
      slug: "existing-shell",
      name: "Existing",
    });
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("http://x/v1/products/adopt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceOrgSlug: "source-org",
          targetOrgSlug: "target-org",
          mergeInto: "prod_existing",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.product.id).toBe("prod_existing");
    expect(json.mergedInto).toBe("existing-shell");
  });

  it("self-adopt (sourceOrg === targetOrg) is rejected with 409 before any writes", async () => {
    const db = mkDb();
    await seedTwoOrgs(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("http://x/v1/products/adopt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceOrgSlug: "target-org",
          targetOrgSlug: "target-org",
        }),
      }),
    );
    expect(res.status).toBe(409);

    // Target org must still exist — the migration helper would have deleted it.
    const remainingOrgs = await db.select().from(organizations);
    expect(remainingOrgs.length).toBe(2);
  });

  it("mergeInto dryRun previews without writing", async () => {
    const db = mkDb();
    await seedTwoOrgs(db);
    await db.insert(products).values({
      id: "prod_existing",
      orgId: "org_target",
      slug: "existing-shell",
      name: "Existing",
    });
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("http://x/v1/products/adopt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceOrgSlug: "source-org",
          targetOrgSlug: "target-org",
          mergeInto: "existing-shell",
          dryRun: true,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.dryRun).toBe(true);
    expect(json.mergeInto).toBe("existing-shell");
    expect(json.sourcesToMove).toEqual(["src-one"]);

    // No writes happened — both seeded orgs still present, source still under source-org.
    const remainingOrgs = await db.select().from(organizations);
    expect(remainingOrgs.length).toBe(2);
    const [src] = await db.select().from(sources).where(eq(sources.id, "src_one"));
    expect(src.orgId).toBe("org_source");
  });
});
