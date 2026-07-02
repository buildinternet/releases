/**
 * Validator regression coverage for the release-level write routes wired
 * in the Phase 2 sweep:
 *   - POST   /v1/releases/:id/coverage    (releases.ts)
 *   - DELETE /v1/releases/:id/coverage    (releases.ts; no body schema)
 *   - PATCH  /v1/releases/:id             (sources.ts)
 *   - POST   /v1/releases/:id/suppress    (sources.ts)
 *   - DELETE /v1/releases/batch            (sources.ts)
 *   - POST   /v1/releases/batch-suppress   (sources.ts)
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { releaseRoutes } from "../../workers/api/src/routes/releases.js";
import { sourceRoutes } from "../../workers/api/src/routes/sources.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { releaseCoverage } from "../../src/db/schema-coverage.js";
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

async function callRel(path: string, method: string, body?: unknown): Promise<Response> {
  return releaseRoutes.request(
    path,
    {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    makeEnv(),
    noopCtx as unknown as Parameters<typeof releaseRoutes.request>[3],
  );
}

async function callSrc(path: string, method: string, body?: unknown): Promise<Response> {
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

async function seed() {
  await testDb.db.insert(organizations).values({
    id: "org_acme",
    name: "Acme",
    slug: "acme",
    discovery: "curated",
  });
  await testDb.db.insert(sources).values({
    id: "src_a",
    orgId: "org_acme",
    name: "Acme Blog",
    slug: "acme-blog",
    type: "feed",
    url: "https://acme.test/feed",
  });
  await testDb.db.insert(releases).values([
    { id: "rel_canon", sourceId: "src_a", title: "v1", content: "hi" },
    { id: "rel_cov_1", sourceId: "src_a", title: "v1 blog post", content: "matching" },
    { id: "rel_cov_2", sourceId: "src_a", title: "v1 changelog", content: "matching" },
  ]);
}

describe("POST /v1/releases/:id/coverage (validateJson)", () => {
  test("400 when coverageIds is missing (schema min(1))", async () => {
    await seed();
    const res = await callRel("/releases/rel_canon/coverage", "POST", {
      decidedBy: "human:zach",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("400 when coverageIds is an empty array (schema min(1))", async () => {
    await seed();
    const res = await callRel("/releases/rel_canon/coverage", "POST", {
      coverageIds: [],
      decidedBy: "human:zach",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("400 when decidedBy lacks the human:/agent: prefix (schema regex)", async () => {
    await seed();
    const res = await callRel("/releases/rel_canon/coverage", "POST", {
      coverageIds: ["rel_cov_1"],
      decidedBy: "bot",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("400 self-coverage rejected by handler", async () => {
    await seed();
    const res = await callRel("/releases/rel_canon/coverage", "POST", {
      coverageIds: ["rel_canon"],
      decidedBy: "human:zach",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("itself");
  });

  test("happy path links coverage rows", async () => {
    await seed();
    const res = await callRel("/releases/rel_canon/coverage", "POST", {
      coverageIds: ["rel_cov_1", "rel_cov_2"],
      decidedBy: "human:zach",
      reason: "marketing post",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { linked: number };
    expect(body.linked).toBe(2);

    const rows = await testDb.db
      .select()
      .from(releaseCoverage)
      .where(eq(releaseCoverage.canonicalId, "rel_canon"));
    expect(rows).toHaveLength(2);
  });
});

describe("PATCH /v1/releases/:id (validateJson .strict())", () => {
  test("400 when body has a non-whitelisted field (strict mode)", async () => {
    await seed();
    const res = await callSrc("/releases/rel_canon", "PATCH", { suppressed: true });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("400 when content is wrong type", async () => {
    await seed();
    const res = await callSrc("/releases/rel_canon", "PATCH", { content: 42 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("400 when body is empty (handler check after schema)", async () => {
    await seed();
    const res = await callSrc("/releases/rel_canon", "PATCH", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message.toLowerCase()).toContain("no writable fields");
  });

  test("happy path: nullable url accepts null", async () => {
    await seed();
    const res = await callSrc("/releases/rel_canon", "PATCH", { url: null });
    expect(res.status).toBe(200);
  });

  test("404 when release doesn't exist", async () => {
    await seed();
    const res = await callSrc("/releases/rel_ghost", "PATCH", { title: "x" });
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/releases/:id/suppress (validateJson)", () => {
  test("happy path with no body sets suppressed=true", async () => {
    await seed();
    const res = await callSrc("/releases/rel_canon/suppress", "POST", {});
    expect(res.status).toBe(200);
    const [row] = await testDb.db.select().from(releases).where(eq(releases.id, "rel_canon"));
    expect(row?.suppressed).toBe(true);
  });

  test("omitted body (no Content-Type, no payload) also sets suppressed=true", async () => {
    // Distinct from the `{}` case: this exercises the path where Hono's
    // validator falls through without parsing because Content-Type isn't
    // application/json, leaving value={} for the schema to validate. Locks
    // in the middleware-compat behavior that replaced the prior
    // `.catch(() => ({}))` parse shim.
    await seed();
    const res = await callSrc("/releases/rel_canon/suppress", "POST");
    expect(res.status).toBe(200);
    const [row] = await testDb.db.select().from(releases).where(eq(releases.id, "rel_canon"));
    expect(row?.suppressed).toBe(true);
    expect(row?.suppressedReason).toBeNull();
  });

  test("happy path with reason stores it", async () => {
    await seed();
    const res = await callSrc("/releases/rel_canon/suppress", "POST", { reason: "spam" });
    expect(res.status).toBe(200);
    const [row] = await testDb.db.select().from(releases).where(eq(releases.id, "rel_canon"));
    expect(row?.suppressedReason).toBe("spam");
  });

  test("400 when reason is the wrong type", async () => {
    await seed();
    const res = await callSrc("/releases/rel_canon/suppress", "POST", { reason: 42 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("404 when release doesn't exist", async () => {
    const res = await callSrc("/releases/rel_ghost/suppress", "POST", {});
    expect(res.status).toBe(404);
  });
});

describe("DELETE /v1/releases/batch (validateJson)", () => {
  test("400 when releaseIds is empty", async () => {
    const res = await callSrc("/releases/batch", "DELETE", { releaseIds: [] });
    expect(res.status).toBe(400);
  });

  test("400 when releaseIds is missing", async () => {
    const res = await callSrc("/releases/batch", "DELETE", {});
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/releases/batch-suppress (validateJson)", () => {
  test("400 when suppressed is missing", async () => {
    const res = await callSrc("/releases/batch-suppress", "POST", { releaseIds: ["rel_a"] });
    expect(res.status).toBe(400);
  });

  test("400 when releaseIds is empty", async () => {
    const res = await callSrc("/releases/batch-suppress", "POST", {
      releaseIds: [],
      suppressed: true,
    });
    expect(res.status).toBe(400);
  });
});
