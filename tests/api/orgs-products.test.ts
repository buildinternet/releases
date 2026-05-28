/**
 * Tests for #1225: GET /v1/orgs/:slug/products — org-scoped product list.
 *
 * Mirrors the generic GET /v1/products?orgId= collection but resolves the org
 * from the path slug (or org_… id) and always scopes to that org. Same
 * `{items, pagination}` envelope; supports `?kind=` (own-kind match).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, products } from "@buildinternet/releases-core/schema";
import { productRoutes } from "../../workers/api/src/routes/products.js";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { makeCaller } from "./route-test-helpers.js";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

function makeEnv() {
  return { DB: testDb.db as unknown as never, MEDIA_ORIGIN: "" };
}

const callProduct = makeCaller(productRoutes, makeEnv);

async function seedOrg(slug: string) {
  await testDb.db
    .insert(organizations)
    .values({ id: `org_${slug}`, name: slug, slug, discovery: "curated" });
}

async function seedProduct(opts: {
  id: string;
  slug: string;
  orgSlug: string;
  kind?: "platform" | "tool" | null;
}) {
  await testDb.db.insert(products).values({
    id: opts.id,
    name: `${opts.slug}-product`,
    slug: opts.slug,
    orgId: `org_${opts.orgSlug}`,
    kind: opts.kind ?? null,
  });
}

type ListBody = {
  items: Array<{ id: string; slug: string; orgId: string; kind: string | null }>;
  pagination: { page: number; pageSize: number; returned: number; totalItems?: number };
};

describe("GET /v1/orgs/:slug/products", () => {
  it("returns only the named org's products in a paginated envelope", async () => {
    await seedOrg("acme");
    await seedOrg("globex");
    await seedProduct({ id: "prod_a1", slug: "a-one", orgSlug: "acme" });
    await seedProduct({ id: "prod_a2", slug: "a-two", orgSlug: "acme" });
    await seedProduct({ id: "prod_g1", slug: "g-one", orgSlug: "globex" });

    const res = await callProduct("/orgs/acme/products");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.items.map((p) => p.id).toSorted()).toEqual(["prod_a1", "prod_a2"]);
    expect(body.items.every((p) => p.orgId === "org_acme")).toBe(true);
    expect(body.pagination.totalItems).toBe(2);
    expect(body.pagination.returned).toBe(2);
  });

  it("resolves the org by typed org_… id as well as slug", async () => {
    await seedOrg("acme");
    await seedProduct({ id: "prod_a1", slug: "a-one", orgSlug: "acme" });

    const res = await callProduct("/orgs/org_acme/products");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.items.map((p) => p.id)).toEqual(["prod_a1"]);
  });

  it("filters by ?kind= on the product's own kind", async () => {
    await seedOrg("acme");
    await seedProduct({ id: "prod_plat", slug: "plat", orgSlug: "acme", kind: "platform" });
    await seedProduct({ id: "prod_tool", slug: "tool", orgSlug: "acme", kind: "tool" });

    const res = await callProduct("/orgs/acme/products?kind=platform");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.items.map((p) => p.id)).toEqual(["prod_plat"]);
  });

  it("404s when the org does not exist", async () => {
    const res = await callProduct("/orgs/nope/products");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("400s on an invalid kind value", async () => {
    await seedOrg("acme");
    const res = await callProduct("/orgs/acme/products?kind=bogus");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });
});
