/**
 * Validator regression coverage for orgs.ts write routes. Each endpoint
 * dropped its hand-rolled body parser in favor of `validateJson(schema)`.
 * Asserts the `{ error: "bad_request", message }` envelope and that
 * runtime-state checks still run in the handler.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { orgRoutes } from "../../workers/api/src/routes/orgs.js";
import { organizations, tags, orgTags } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

function makeEnv(extra: Record<string, unknown> = {}) {
  return { DB: testDb.db as unknown as never, ...extra };
}

// `c.executionCtx.waitUntil(...)` is called by some handlers for fire-and-forget
// embed work. Hono's test runner doesn't provide an ExecutionContext, so pass
// one explicitly via the third arg to `.request()`.
const noopCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

async function call(path: string, method: string, body?: unknown): Promise<Response> {
  return orgRoutes.request(
    path,
    {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
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

describe("POST /v1/orgs (validateJson)", () => {
  test("400 when name is missing", async () => {
    const res = await call("/orgs", "POST", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message.toLowerCase()).toContain("name");
  });

  test("400 when name is the empty string", async () => {
    const res = await call("/orgs", "POST", { name: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("400 when tags is not an array of strings", async () => {
    const res = await call("/orgs", "POST", { name: "Acme", tags: [42] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("happy path creates the org", async () => {
    const res = await call("/orgs", "POST", { name: "Acme Co" });
    expect(res.status).toBe(201);
    const row = (await res.json()) as { id: string; slug: string; name: string };
    expect(row.slug).toBe("acme-co");
    expect(row.name).toBe("Acme Co");
  });
});

describe("PATCH /v1/orgs/:slug (validateJson)", () => {
  test("happy path updates description (null clears it)", async () => {
    await seedOrg();
    const res = await call("/orgs/acme", "PATCH", { description: "Test desc" });
    expect(res.status).toBe(200);
    const [row] = await testDb.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, "org_acme"));
    expect(row?.description).toBe("Test desc");
  });

  test("400 when category is a wrong type (not a string)", async () => {
    await seedOrg();
    const res = await call("/orgs/acme", "PATCH", { category: 123 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });
});

describe("PUT /v1/orgs/:slug/tags (validateJson)", () => {
  test("happy path adds tags to the org", async () => {
    await seedOrg();
    const res = await call("/orgs/acme/tags", "PUT", { tags: ["ai", "saas"] });
    expect(res.status).toBe(200);
    const links = await testDb.db
      .select({ tagId: orgTags.tagId })
      .from(orgTags)
      .where(eq(orgTags.orgId, "org_acme"));
    expect(links).toHaveLength(2);
  });

  test("400 when tags is not an array", async () => {
    await seedOrg();
    const res = await call("/orgs/acme/tags", "PUT", { tags: "ai" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("400 when tags contains non-strings", async () => {
    await seedOrg();
    const res = await call("/orgs/acme/tags", "PUT", { tags: ["ok", 99] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("404 when org doesn't exist", async () => {
    const res = await call("/orgs/ghost/tags", "PUT", { tags: ["ai"] });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /v1/orgs/:slug/tags (validateJson)", () => {
  test("400 when tags missing", async () => {
    await seedOrg();
    const res = await call("/orgs/acme/tags", "DELETE", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("happy path removes tags silently when none match", async () => {
    await seedOrg();
    const res = await call("/orgs/acme/tags", "DELETE", { tags: ["nonexistent"] });
    expect(res.status).toBe(200);
  });
});

describe("POST /v1/tags (validateJson)", () => {
  test("creates a new tag (201)", async () => {
    const res = await call("/tags", "POST", { name: "fresh-tag" });
    expect(res.status).toBe(201);
    const row = (await res.json()) as { slug: string; name: string };
    expect(row.slug).toBe("fresh-tag");
  });

  test("returns existing tag (200) on duplicate", async () => {
    await testDb.db.insert(tags).values({
      id: "tag_x",
      name: "existing",
      slug: "existing",
      createdAt: new Date().toISOString(),
    });
    const res = await call("/tags", "POST", { name: "existing" });
    expect(res.status).toBe(200);
  });

  test("400 when name missing", async () => {
    const res = await call("/tags", "POST", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("400 when name is the empty string (schema min(1))", async () => {
    const res = await call("/tags", "POST", { name: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });
});

describe("POST /v1/orgs/:slug/accounts (validateJson)", () => {
  test("400 when platform missing", async () => {
    await seedOrg();
    const res = await call("/orgs/acme/accounts", "POST", { handle: "@acme" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("platform");
  });

  test("400 when both fields are empty strings", async () => {
    await seedOrg();
    const res = await call("/orgs/acme/accounts", "POST", { platform: "", handle: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("happy path creates the account", async () => {
    await seedOrg();
    const res = await call("/orgs/acme/accounts", "POST", {
      platform: "twitter",
      handle: "@acme",
    });
    expect(res.status).toBe(201);
  });

  test("404 when org doesn't exist", async () => {
    const res = await call("/orgs/ghost/accounts", "POST", {
      platform: "twitter",
      handle: "@a",
    });
    expect(res.status).toBe(404);
  });
});
