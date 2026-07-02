/**
 * Validator regression coverage for the sources.ts write routes that now
 * use validateJson(schema):
 *   - POST /v1/sources                       → CreateSourceBodySchema
 *   - POST /v1/sources/:slug/content-hash    → SourceContentHashBodySchema
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { sourceRoutes } from "../../workers/api/src/routes/sources.js";
import { organizations, sources } from "@buildinternet/releases-core/schema";
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
  return sourceRoutes.request(
    path,
    {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    makeEnv(),
    noopCtx as unknown as Parameters<typeof sourceRoutes.request>[3],
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

async function seedSource() {
  await seedOrg();
  await testDb.db.insert(sources).values({
    id: "src_blog",
    orgId: "org_acme",
    name: "Acme Blog",
    slug: "acme-blog",
    type: "feed",
    url: "https://acme.test/blog.xml",
  });
}

describe("POST /v1/sources (validateJson)", () => {
  test("400 when name is missing", async () => {
    await seedOrg();
    const res = await call("/sources", "POST", {
      url: "https://x.test",
      orgSlug: "acme",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("400 when url is missing", async () => {
    await seedOrg();
    const res = await call("/sources", "POST", { name: "X", orgSlug: "acme" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("400 when source type is invalid (schema enum)", async () => {
    await seedOrg();
    const res = await call("/sources", "POST", {
      name: "X",
      url: "https://x.test",
      type: "not-a-real-type",
      orgSlug: "acme",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("400 when neither orgId nor orgSlug resolves (handler check)", async () => {
    const res = await call("/sources", "POST", { name: "X", url: "https://x.test" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; type: string; message: string } };
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message.toLowerCase()).toContain("orgid or orgslug");
  });

  test("happy path creates source", async () => {
    await seedOrg();
    const res = await call("/sources", "POST", {
      name: "Test Site",
      url: "https://test.test/changelog",
      orgSlug: "acme",
    });
    expect(res.status).toBe(201);
    const row = (await res.json()) as { slug: string };
    expect(row.slug).toBe("test-site");
  });
});

describe("POST /v1/sources/:slug/content-hash (validateJson)", () => {
  test("400 when contentHash missing", async () => {
    await seedSource();
    const res = await call("/sources/acme-blog/content-hash", "POST", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("400 when contentHash is empty string (schema min(1))", async () => {
    await seedSource();
    const res = await call("/sources/acme-blog/content-hash", "POST", { contentHash: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("400 when contentHash is the wrong type", async () => {
    await seedSource();
    const res = await call("/sources/acme-blog/content-hash", "POST", { contentHash: 42 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("happy path: first call updates lastContentHash (typed source ID)", async () => {
    await seedSource();
    // Bare-slug routes reject non-typed identifiers post-#698; use the typed
    // `src_…` ID directly.
    const res = await call("/sources/src_blog/content-hash", "POST", {
      contentHash: "abc123",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { unchanged: boolean };
    expect(body.unchanged).toBe(false);

    const [row] = await testDb.db.select().from(sources).where(eq(sources.id, "src_blog"));
    expect(row?.lastContentHash).toBe("abc123");
  });

  test("happy path: second call with same hash returns unchanged", async () => {
    await seedSource();
    await testDb.db
      .update(sources)
      .set({ lastContentHash: "abc123" })
      .where(eq(sources.id, "src_blog"));
    const res = await call("/sources/src_blog/content-hash", "POST", {
      contentHash: "abc123",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { unchanged: boolean };
    expect(body.unchanged).toBe(true);
  });

  test("404 when source ID doesn't exist", async () => {
    const res = await call("/sources/src_ghost/content-hash", "POST", {
      contentHash: "abc",
    });
    expect(res.status).toBe(404);
  });

  test("happy path via org-scoped path: matches slug under correct org", async () => {
    await seedSource();
    const res = await call("/orgs/acme/sources/acme-blog/content-hash", "POST", {
      contentHash: "deadbeef",
    });
    expect(res.status).toBe(200);
  });
});
