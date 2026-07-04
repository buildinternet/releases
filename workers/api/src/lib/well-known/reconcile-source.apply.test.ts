import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, sources, products } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../test/setup.js";
import { syncSourceRepo } from "./reconcile-source.js";

function fileResp(body: unknown) {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

async function seed(db: any) {
  await db.insert(organizations).values({ id: "org_a", slug: "acme", name: "Acme" });
  await db.insert(sources).values([
    {
      id: "src_1",
      orgId: "org_a",
      name: "Cloud repo",
      slug: "cloud",
      type: "github",
      url: "https://github.com/acme/cloud",
    },
    {
      id: "src_2",
      orgId: "org_a",
      name: "Cloud CLI",
      slug: "cloud-cli",
      type: "github",
      url: "https://github.com/acme/cloud-cli",
    },
  ]);
}

describe("syncSourceRepo", () => {
  it("creates a product and attaches the source", async () => {
    const db = createTestDb();
    await seed(db);
    const res = await syncSourceRepo(db as any, "src_1", {
      fetchImpl: fileResp({ version: 2, product: { name: "Acme Cloud" } }),
    });
    expect(res.applied).toBe(true);
    const [s] = await db.select().from(sources).where(eq(sources.id, "src_1"));
    const [p] = await db.select().from(products).where(eq(products.slug, "acme-cloud"));
    expect(s!.productId).toBe(p!.id);
  });

  it("groups a second repo onto the SAME product (same slug)", async () => {
    const db = createTestDb();
    await seed(db);
    await syncSourceRepo(db as any, "src_1", {
      fetchImpl: fileResp({ version: 2, product: { name: "Acme Cloud" } }),
    });
    await syncSourceRepo(db as any, "src_2", {
      fetchImpl: fileResp({ version: 2, product: { name: "Acme Cloud" } }),
    });
    const prods = await db.select().from(products).where(eq(products.orgId, "org_a"));
    expect(prods.length).toBe(1);
    const [s1] = await db.select().from(sources).where(eq(sources.id, "src_1"));
    const [s2] = await db.select().from(sources).where(eq(sources.id, "src_2"));
    expect(s1!.productId).toBe(s2!.productId);
  });

  it("never alters an existing product's description", async () => {
    const db = createTestDb();
    await seed(db);
    await db.insert(products).values({
      id: "prod_1",
      orgId: "org_a",
      name: "Acme Cloud",
      slug: "acme-cloud",
      description: "Curated copy",
    });
    await syncSourceRepo(db as any, "src_1", {
      fetchImpl: fileResp({ version: 2, product: { name: "Acme Cloud" } }),
    });
    const [p] = await db.select().from(products).where(eq(products.slug, "acme-cloud"));
    expect(p!.description).toBe("Curated copy");
    const [s] = await db.select().from(sources).where(eq(sources.id, "src_1"));
    expect(s!.productId).toBe("prod_1");
  });

  it("no-ops for a non-github source", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_b", slug: "beta", name: "Beta" });
    await db.insert(sources).values({
      id: "src_x",
      orgId: "org_b",
      name: "Feed",
      slug: "feed",
      type: "feed",
      url: "https://beta.com/changelog",
    });
    const res = await syncSourceRepo(db as any, "src_x", {
      fetchImpl: fileResp({ version: 2, product: { name: "X" } }),
    });
    expect(res.applied).toBe(false);
    expect(res.skippedReason).toBe("not_github");
  });

  it("does not create an orphan product for a curator-assigned source", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_c", slug: "gamma", name: "Gamma" });
    await db
      .insert(products)
      .values({ id: "prod_keep", orgId: "org_c", name: "Keep", slug: "keep" });
    await db.insert(sources).values({
      id: "src_k",
      orgId: "org_c",
      name: "Repo",
      slug: "repo",
      type: "github",
      url: "https://github.com/gamma/repo",
      productId: "prod_keep",
    });
    await syncSourceRepo(db as any, "src_k", {
      fetchImpl: fileResp({ version: 2, product: { name: "Brand New", slug: "brand-new" } }),
    });
    const created = await db.select().from(products).where(eq(products.slug, "brand-new"));
    expect(created.length).toBe(0);
    const [s] = await db.select().from(sources).where(eq(sources.id, "src_k"));
    expect(s!.productId).toBe("prod_keep");
  });
});
