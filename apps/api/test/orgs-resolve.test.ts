import { beforeEach, afterEach, describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, products, sources } from "@buildinternet/releases-core/schema";
import { productRoutes } from "../src/routes/products.js";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { makeCaller, makeJsonCaller } from "./route-test-helpers.js";

let testDb: TestDatabase;
beforeEach(() => {
  testDb = createTestDb();
});
afterEach(() => {
  testDb.cleanup();
});
const makeEnv = () => ({ DB: testDb.db as unknown as never });
const call = makeCaller(productRoutes, makeEnv);
const callJson = makeJsonCaller(productRoutes, makeEnv);

async function seed() {
  await testDb.db.insert(organizations).values({
    id: "org_vercel",
    name: "Vercel",
    slug: "vercel",
    discovery: "curated",
  });
  await testDb.db.insert(products).values({
    id: "prod_turbo",
    name: "Turborepo",
    slug: "turborepo",
    orgId: "org_vercel",
    kind: "tool",
  });
  await testDb.db.insert(sources).values({
    id: "src_turbo",
    name: "Turborepo repo",
    slug: "turborepo",
    orgId: "org_vercel",
    productId: "prod_turbo",
    type: "github",
    url: "https://github.com/vercel/turborepo",
    metadata: "{}",
  });
  await testDb.db.insert(sources).values({
    id: "src_docs",
    name: "Vercel Docs",
    slug: "vercel-docs",
    orgId: "org_vercel",
    type: "scrape",
    url: "https://vercel.com/docs",
    metadata: "{}",
  });
}

describe("GET /v1/orgs/:org/resolve/:slug", () => {
  it("returns kind=product when a product owns the slug (product-first, even on collision)", async () => {
    await seed();
    const res = await call("/orgs/vercel/resolve/turborepo");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; product: { slug: string } };
    expect(body.kind).toBe("product");
    expect(body.product.slug).toBe("turborepo");
  });

  it("returns kind=source for a non-shadowed source slug", async () => {
    await seed();
    const res = await call("/orgs/vercel/resolve/vercel-docs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; source: { slug: string } };
    expect(body.kind).toBe("source");
    expect(body.source.slug).toBe("vercel-docs");
  });

  it("404s when neither a product nor a source matches", async () => {
    await seed();
    const res = await call("/orgs/vercel/resolve/nope");
    expect(res.status).toBe(404);
  });

  it("404s for an unknown org", async () => {
    await seed();
    const res = await call("/orgs/ghost/resolve/turborepo");
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/products source-slug guard", () => {
  it("rejects with 409 when the new product slug is held by an existing source", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });
    await testDb.db.insert(sources).values({
      id: "src_cli",
      name: "Acme CLI",
      slug: "acme-cli",
      orgId: "org_acme",
      type: "github",
      url: "https://github.com/acme/cli",
      metadata: "{}",
    });
    const res = await callJson("/products", "POST", {
      name: "Acme CLI",
      slug: "acme-cli",
      orgSlug: "acme",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("conflict");
    expect(body.error.message).toContain("already used by a source");
    const rows = await testDb.db.select().from(products).where(eq(products.orgId, "org_acme"));
    expect(rows).toHaveLength(0);
  });

  it("creates the product when no source holds the slug", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_beta",
      name: "Beta",
      slug: "beta",
      discovery: "curated",
    });
    const res = await callJson("/products", "POST", {
      name: "Beta SDK",
      slug: "beta-sdk",
      orgSlug: "beta",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string };
    expect(body.slug).toBe("beta-sdk");
  });
});
