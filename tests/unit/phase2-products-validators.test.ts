/**
 * Validator regression coverage for products.ts write routes. Each endpoint
 * dropped its hand-rolled body parser in favor of `validateJson(schema)`.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { productRoutes } from "../../workers/api/src/routes/products.js";
import { organizations, products, productTags, tags } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";

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

async function call(path: string, method: string, body?: unknown): Promise<Response> {
  return productRoutes.request(
    path,
    {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    makeEnv(),
    noopCtx as unknown as Parameters<typeof productRoutes.request>[3],
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

async function seedProduct() {
  await seedOrg();
  await testDb.db.insert(products).values({
    id: "prod_widget",
    name: "Widget",
    slug: "widget",
    orgId: "org_acme",
  });
}

describe("POST /v1/products (validateJson)", () => {
  test("400 when name is missing", async () => {
    const res = await call("/products", "POST", { orgSlug: "acme" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("400 when neither orgId nor orgSlug is supplied (handler cross-field check)", async () => {
    const res = await call("/products", "POST", { name: "Widget" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; type: string; message: string } };
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message.toLowerCase()).toContain("orgid or orgslug");
  });

  test("happy path creates the product", async () => {
    await seedOrg();
    const res = await call("/products", "POST", { name: "Widget", orgSlug: "acme" });
    expect(res.status).toBe(201);
    const row = (await res.json()) as { id: string; slug: string; name: string };
    expect(row.slug).toBe("widget");
  });

  test("404 when org doesn't exist", async () => {
    const res = await call("/products", "POST", { name: "W", orgSlug: "ghost" });
    expect(res.status).toBe(404);
  });

  test("400 when category is the empty string (alias-normalization boundary)", async () => {
    // Pre-tightening, the handler's truthy-guard around resolveCategoryInput
    // would have skipped normalization for "" and persisted the blank as the
    // category column. The schema's .min(1) now rejects it at the boundary.
    await seedOrg();
    const res = await call("/products", "POST", {
      name: "Widget",
      orgSlug: "acme",
      category: "",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });
});

describe("PATCH /v1/products/:slug (validateJson)", () => {
  test("happy path updates description", async () => {
    await seedProduct();
    const res = await call("/products/prod_widget", "PATCH", { description: "Cool" });
    expect(res.status).toBe(200);
    const [row] = await testDb.db.select().from(products).where(eq(products.id, "prod_widget"));
    expect(row?.description).toBe("Cool");
  });

  test("400 when name is wrong type (schema)", async () => {
    await seedProduct();
    const res = await call("/products/prod_widget", "PATCH", { name: 42 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });
});

describe("PUT /v1/products/:identifier/tags (validateJson)", () => {
  test("400 when tags is not an array", async () => {
    await seedProduct();
    const res = await call("/products/prod_widget/tags", "PUT", { tags: "x" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("happy path adds tags", async () => {
    await seedProduct();
    const res = await call("/products/prod_widget/tags", "PUT", { tags: ["ai"] });
    expect(res.status).toBe(200);
    const links = await testDb.db
      .select()
      .from(productTags)
      .where(eq(productTags.productId, "prod_widget"));
    expect(links).toHaveLength(1);
  });

  test("404 when product doesn't exist", async () => {
    const res = await call("/products/prod_ghost/tags", "PUT", { tags: ["x"] });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /v1/products/:identifier/tags (validateJson)", () => {
  test("happy path: removes silently when no tags match", async () => {
    await seedProduct();
    const res = await call("/products/prod_widget/tags", "DELETE", { tags: ["nothing"] });
    expect(res.status).toBe(200);
  });

  test("400 when body shape wrong", async () => {
    await seedProduct();
    const res = await call("/products/prod_widget/tags", "DELETE", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });
});

describe("POST /v1/products/adopt (validateJson)", () => {
  test("400 when sourceOrgSlug missing", async () => {
    const res = await call("/products/adopt", "POST", { targetOrgSlug: "acme" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("400 when both source and target slugs are empty strings (schema min(1))", async () => {
    const res = await call("/products/adopt", "POST", {
      sourceOrgSlug: "",
      targetOrgSlug: "",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("404 when source org doesn't exist", async () => {
    await seedOrg();
    const res = await call("/products/adopt", "POST", {
      sourceOrgSlug: "ghost",
      targetOrgSlug: "acme",
    });
    expect(res.status).toBe(404);
  });
});

// Silence unused-import warning when the test file gets pruned by oxlint
void tags;
