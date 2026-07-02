/**
 * Tests for Task 5: kind field accepted on write paths (POST + PATCH)
 * for both products and sources.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { productRoutes } from "../../workers/api/src/routes/products.js";
import { sourceRoutes } from "../../workers/api/src/routes/sources.js";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { makeJsonCaller } from "./route-test-helpers.js";

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

const callProduct = makeJsonCaller(productRoutes, makeEnv);
const callSource = makeJsonCaller(sourceRoutes, makeEnv);

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
    const res = await callProduct("/products", "POST", {
      name: "Py SDK",
      slug: "py-sdk",
      orgSlug: "acme",
      kind: "sdk",
    });
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

    const res = await callSource("/orgs/acme/sources/acme-feed", "PATCH", { kind: "sdk" });
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

    const res = await callSource("/orgs/acme/sources/x", "PATCH", { kind: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe(null);
  });

  it("rejects an invalid kind value on POST /v1/products", async () => {
    await seedOrg("acme");
    const res = await callProduct("/products", "POST", {
      name: "Y",
      slug: "y",
      orgSlug: "acme",
      kind: "framework",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error.code).toBe("validation_failed");
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

    const res = await callSource("/orgs/acme/sources/acme-feed", "PATCH", { kind: "framework" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("bad_request");
  });
});
