/**
 * Tests for Task 4: kind field surfaced on product/source read responses and
 * catalog entries; catalog discriminator renamed to entryType.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, products, sources } from "@buildinternet/releases-core/schema";
import { productRoutes } from "../../workers/api/src/routes/products.js";
import { sourceRoutes } from "../../workers/api/src/routes/sources.js";
import { orgRoutes } from "../../workers/api/src/routes/orgs.js";
import { createTestDb, type TestDatabase } from "../db-helper.js";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

function makeEnv() {
  return { DB: testDb.db as unknown as never };
}

const noopCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

async function callProduct(path: string): Promise<Response> {
  return productRoutes.request(
    path,
    { method: "GET" },
    makeEnv(),
    noopCtx as unknown as Parameters<typeof productRoutes.request>[3],
  );
}

async function callSource(path: string): Promise<Response> {
  return sourceRoutes.request(
    path,
    { method: "GET" },
    makeEnv(),
    noopCtx as unknown as Parameters<typeof sourceRoutes.request>[3],
  );
}

async function callOrg(path: string): Promise<Response> {
  return orgRoutes.request(
    path,
    { method: "GET" },
    makeEnv(),
    noopCtx as unknown as Parameters<typeof orgRoutes.request>[3],
  );
}

async function seedOrg() {
  await testDb.db.insert(organizations).values({
    id: "org_acme",
    name: "Acme",
    slug: "acme",
    discovery: "curated",
  });
}

describe("kind on product read responses", () => {
  it("GET /v1/orgs/:orgSlug/products/:productSlug returns kind", async () => {
    await seedOrg();
    await testDb.db.insert(products).values({
      id: "prod_sdk1",
      name: "Acme SDK",
      slug: "acme-sdk",
      orgId: "org_acme",
      kind: "sdk",
    });

    const res = await callProduct("/orgs/acme/products/acme-sdk");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("sdk");
  });

  it("GET /v1/products list includes kind", async () => {
    await seedOrg();
    await testDb.db.insert(products).values({
      id: "prod_plat1",
      name: "Acme Platform",
      slug: "acme-platform",
      orgId: "org_acme",
      kind: "platform",
    });

    const res = await callProduct("/products?orgId=org_acme");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    const item = body.items[0];
    expect(item?.kind).toBe("platform");
  });

  it("kind is null when not set on product", async () => {
    await seedOrg();
    await testDb.db.insert(products).values({
      id: "prod_nok1",
      name: "No Kind",
      slug: "no-kind",
      orgId: "org_acme",
    });

    const res = await callProduct("/orgs/acme/products/no-kind");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind === null || body.kind === undefined).toBe(true);
  });
});

describe("kind on source read responses", () => {
  it("GET /v1/orgs/:orgSlug/sources/:sourceSlug returns kind", async () => {
    await seedOrg();
    await testDb.db.insert(sources).values({
      id: "src_docs1",
      name: "Acme Docs",
      slug: "acme-docs",
      orgId: "org_acme",
      type: "scrape",
      url: "https://docs.acme.com",
      metadata: "{}",
      kind: "docs",
    });

    const res = await callSource("/orgs/acme/sources/acme-docs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("docs");
  });

  it("kind is null when not set on source", async () => {
    await seedOrg();
    await testDb.db.insert(sources).values({
      id: "src_nok1",
      name: "No Kind Source",
      slug: "no-kind-src",
      orgId: "org_acme",
      type: "feed",
      url: "https://acme.com/feed",
      metadata: "{}",
    });

    const res = await callSource("/orgs/acme/sources/no-kind-src");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind === null || body.kind === undefined).toBe(true);
  });
});

describe("entryType + kind on org catalog", () => {
  it("GET /v1/orgs/:slug/catalog returns entryType and kind on each entry", async () => {
    await seedOrg();
    await testDb.db.insert(products).values({
      id: "prod_py1",
      name: "Python SDK",
      slug: "py",
      orgId: "org_acme",
      kind: "sdk",
    });
    await testDb.db.insert(sources).values({
      id: "src_docs2",
      name: "Docs",
      slug: "docs",
      orgId: "org_acme",
      type: "scrape",
      url: "https://docs.acme.com",
      metadata: "{}",
      kind: "docs",
    });

    const res = await callOrg("/orgs/acme/catalog");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
    };

    const py = body.items.find((e) => e.slug === "py");
    const docs = body.items.find((e) => e.slug === "docs");

    expect(py?.entryType).toBe("product");
    expect(py?.kind).toBe("sdk");
    expect(docs?.entryType).toBe("source");
    expect(docs?.kind).toBe("docs");
  });

  it("catalog entry kind is null when not set", async () => {
    await seedOrg();
    await testDb.db.insert(products).values({
      id: "prod_nk2",
      name: "No Kind",
      slug: "no-kind-prod",
      orgId: "org_acme",
    });

    const res = await callOrg("/orgs/acme/catalog");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
    };

    const item = body.items.find((e) => e.slug === "no-kind-prod");
    expect(item?.entryType).toBe("product");
    expect(item?.kind === null || item?.kind === undefined).toBe(true);
  });
});
