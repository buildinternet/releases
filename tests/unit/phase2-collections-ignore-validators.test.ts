/**
 * Validator regression coverage for the final Phase 2 sweep:
 *   collections.ts — POST/PATCH /collections, PUT/POST /collections/:slug/members
 *   ignore.ts      — POST /orgs/:slug/ignored-urls, POST /admin/blocklist
 *
 * Asserts the `{ error: { code: "validation_failed", type: "validation", message } }` envelope after wiring
 * `validateJson(schema)` on each route.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { collectionRoutes } from "../../workers/api/src/routes/collections.js";
import { ignoreRoutes } from "../../workers/api/src/routes/ignore.js";
import {
  organizations,
  collections,
  collectionMembers,
  ignoredUrls,
  blockedUrls,
} from "@buildinternet/releases-core/schema";
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

async function call(
  router: typeof collectionRoutes | typeof ignoreRoutes,
  path: string,
  method: string,
  body?: unknown,
): Promise<Response> {
  return router.request(
    path,
    {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    makeEnv(),
    noopCtx as unknown as Parameters<typeof router.request>[3],
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

describe("POST /v1/collections (validateJson)", () => {
  test("400 when name is missing", async () => {
    const res = await call(collectionRoutes, "/collections", "POST", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("400 when name is whitespace-only (handler post-trim check)", async () => {
    const res = await call(collectionRoutes, "/collections", "POST", { name: "   " });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message.toLowerCase()).toContain("name");
  });

  test("400 when slug doesn't match the kebab regex (handler check)", async () => {
    const res = await call(collectionRoutes, "/collections", "POST", {
      name: "Test",
      slug: "BAD SLUG",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("happy path creates the collection", async () => {
    const res = await call(collectionRoutes, "/collections", "POST", {
      name: "My Picks",
      description: "Stuff I like",
    });
    expect(res.status).toBe(201);
    const [row] = await testDb.db
      .select()
      .from(collections)
      .where(eq(collections.slug, "my-picks"));
    expect(row?.name).toBe("My Picks");
  });
});

describe("PATCH /v1/collections/:slug (validateJson)", () => {
  test("happy path updates name", async () => {
    await testDb.db.insert(collections).values({
      id: "col_1",
      slug: "picks",
      name: "Picks",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const res = await call(collectionRoutes, "/collections/picks", "PATCH", {
      name: "Renamed",
    });
    expect(res.status).toBe(200);
    const [row] = await testDb.db.select().from(collections).where(eq(collections.slug, "picks"));
    expect(row?.name).toBe("Renamed");
  });

  test("400 when name is wrong type (schema)", async () => {
    const res = await call(collectionRoutes, "/collections/picks", "PATCH", { name: 42 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("404 when slug doesn't exist", async () => {
    const res = await call(collectionRoutes, "/collections/ghost", "PATCH", {
      name: "Whatever",
    });
    expect(res.status).toBe(404);
  });
});

describe("PUT /v1/collections/:slug/members (validateJson)", () => {
  beforeEach(async () => {
    await testDb.db.insert(collections).values({
      id: "col_1",
      slug: "picks",
      name: "Picks",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await seedOrg();
  });

  test("400 when orgs is missing", async () => {
    const res = await call(collectionRoutes, "/collections/picks/members", "PUT", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("happy path replaces membership atomically", async () => {
    const res = await call(collectionRoutes, "/collections/picks/members", "PUT", {
      orgs: [{ orgSlug: "acme" }],
    });
    expect(res.status).toBe(200);
    const links = await testDb.db
      .select()
      .from(collectionMembers)
      .where(eq(collectionMembers.collectionId, "col_1"));
    expect(links).toHaveLength(1);
    expect(links[0]?.orgId).toBe("org_acme");
  });
});

describe("POST /v1/collections/:slug/members (validateJson)", () => {
  test("400 when neither orgId nor orgSlug supplied (handler resolver)", async () => {
    await testDb.db.insert(collections).values({
      id: "col_1",
      slug: "picks",
      name: "Picks",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const res = await call(collectionRoutes, "/collections/picks/members", "POST", {
      position: 0,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });
});

describe("POST /v1/orgs/:slug/ignored-urls (validateJson)", () => {
  test("400 when url missing", async () => {
    await seedOrg();
    const res = await call(ignoreRoutes, "/orgs/acme/ignored-urls", "POST", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("400 when url is the empty string (schema min(1))", async () => {
    await seedOrg();
    const res = await call(ignoreRoutes, "/orgs/acme/ignored-urls", "POST", { url: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("happy path adds the URL", async () => {
    await seedOrg();
    const res = await call(ignoreRoutes, "/orgs/acme/ignored-urls", "POST", {
      url: "https://acme.test/spam",
      reason: "throwaway",
    });
    expect(res.status).toBe(201);
    const [row] = await testDb.db
      .select()
      .from(ignoredUrls)
      .where(eq(ignoredUrls.url, "https://acme.test/spam"));
    expect(row?.reason).toBe("throwaway");
  });

  test("404 when org missing", async () => {
    const res = await call(ignoreRoutes, "/orgs/ghost/ignored-urls", "POST", {
      url: "https://x.test",
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/admin/blocklist (validateJson)", () => {
  test("400 when pattern missing", async () => {
    const res = await call(ignoreRoutes, "/admin/blocklist", "POST", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("400 when type isn't one of exact|domain (schema enum)", async () => {
    const res = await call(ignoreRoutes, "/admin/blocklist", "POST", {
      pattern: "https://spam.test",
      type: "wildcard",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("happy path adds the pattern", async () => {
    const res = await call(ignoreRoutes, "/admin/blocklist", "POST", {
      pattern: "spam.test",
      type: "domain",
    });
    expect(res.status).toBe(201);
    const [row] = await testDb.db
      .select()
      .from(blockedUrls)
      .where(eq(blockedUrls.pattern, "spam.test"));
    expect(row?.type).toBe("domain");
  });
});
