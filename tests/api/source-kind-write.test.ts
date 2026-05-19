/**
 * Tests for Task 5: kind field accepted on write paths (POST + PATCH)
 * for both products and sources.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { productRoutes } from "../../workers/api/src/routes/products.js";
import { sourceRoutes } from "../../workers/api/src/routes/sources.js";
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

async function seedOrg(slug = "acme") {
  await testDb.db.insert(organizations).values({
    id: `org_${slug}`,
    name: slug,
    slug,
    discovery: "curated",
  });
}

describe("kind on write paths", () => {
  it("POST /v1/products accepts kind:sdk", async () => {
    await seedOrg("acme");
    const res = await productRoutes.request(
      "/products",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Py SDK", slug: "py-sdk", orgSlug: "acme", kind: "sdk" }),
      },
      makeEnv(),
      noopCtx as unknown as Parameters<typeof productRoutes.request>[3],
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("sdk");
  });

  it("PATCH /v1/orgs/:orgSlug/sources/:sourceSlug updates kind", async () => {
    await seedOrg("acme");
    await testDb.db.insert(sources).values({
      id: "src_acme_feed",
      orgId: "org_acme",
      slug: "acme-feed",
      name: "Acme Feed",
      url: "https://acme.com/feed",
      type: "feed",
      metadata: "{}",
    });

    const res = await sourceRoutes.request(
      "/orgs/acme/sources/acme-feed",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "sdk" }),
      },
      makeEnv(),
      noopCtx as unknown as Parameters<typeof sourceRoutes.request>[3],
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("sdk");
  });

  it("PATCH allows clearing kind by sending null", async () => {
    await seedOrg("acme");
    await testDb.db.insert(sources).values({
      id: "src_x",
      orgId: "org_acme",
      slug: "x",
      name: "X",
      url: "https://acme.com/x",
      type: "feed",
      metadata: "{}",
      kind: "sdk",
    });

    const res = await sourceRoutes.request(
      "/orgs/acme/sources/x",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: null }),
      },
      makeEnv(),
      noopCtx as unknown as Parameters<typeof sourceRoutes.request>[3],
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe(null);
  });

  it("rejects an invalid kind value on POST /v1/products", async () => {
    await seedOrg("acme");
    const res = await productRoutes.request(
      "/products",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Y", slug: "y", orgSlug: "acme", kind: "framework" }),
      },
      makeEnv(),
      noopCtx as unknown as Parameters<typeof productRoutes.request>[3],
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("bad_request");
  });

  it("rejects an invalid kind value on PATCH /v1/orgs/:slug/sources/:slug", async () => {
    await seedOrg("acme");
    await testDb.db.insert(sources).values({
      id: "src_acme_invalid",
      orgId: "org_acme",
      slug: "acme-feed",
      name: "Acme Feed",
      url: "https://acme.com/feed",
      type: "feed",
      metadata: "{}",
    });

    const res = await sourceRoutes.request(
      "/orgs/acme/sources/acme-feed",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "framework" }),
      },
      makeEnv(),
      noopCtx as unknown as Parameters<typeof sourceRoutes.request>[3],
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("bad_request");
  });
});
