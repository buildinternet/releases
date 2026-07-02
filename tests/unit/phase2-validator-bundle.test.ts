/**
 * Regression coverage for the Phase 2 trivial-bundle PR: routes that
 * dropped hand-rolled body parsing in favor of `validateJson(schema)`.
 *
 * Each section exercises the happy path + a couple of validator-rejection
 * cases to confirm the `{ error: { code: "validation_failed", type: "validation", message } }` envelope shape
 * and that runtime-state checks still run in the handler.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import playbookRoutes from "../../workers/api/src/routes/playbook.js";
import { taxonomyRoutes } from "../../workers/api/src/routes/taxonomy.js";
import { errataRoutes } from "../../workers/api/src/routes/errata.js";
import { organizations, knowledgePages, categories } from "@buildinternet/releases-core/schema";
import { eq, and } from "drizzle-orm";

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

async function seedOrg(slug = "acme", id = "org_acme") {
  await testDb.db.insert(organizations).values({
    id,
    name: "Acme",
    slug,
    discovery: "curated",
  });
  return { id, slug };
}

describe("PATCH /v1/orgs/:slug/playbook/notes (validateJson)", () => {
  async function patch(slug: string, body: unknown): Promise<Response> {
    return playbookRoutes.request(
      `/orgs/${slug}/playbook/notes`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
      makeEnv(),
    );
  }

  test("happy path bootstraps a playbook row and persists notes", async () => {
    await seedOrg();
    const res = await patch("acme", { notes: "Prefer feeds when available." });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; notes: string | null };
    expect(body).toEqual({ ok: true, notes: "Prefer feeds when available." });

    const [row] = await testDb.db
      .select()
      .from(knowledgePages)
      .where(and(eq(knowledgePages.scope, "playbook"), eq(knowledgePages.orgId, "org_acme")));
    expect(row?.notes).toBe("Prefer feeds when available.");
  });

  test("empty-string notes stored as null", async () => {
    await seedOrg();
    const res = await patch("acme", { notes: "" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; notes: string | null };
    expect(body.notes).toBeNull();
  });

  test("400 bad_request when notes is missing", async () => {
    await seedOrg();
    const res = await patch("acme", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.message.toLowerCase()).toContain("notes");
  });

  test("400 bad_request when notes is not a string", async () => {
    await seedOrg();
    const res = await patch("acme", { notes: 42 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("404 when org doesn't exist (validator passes, handler 404s)", async () => {
    const res = await patch("ghost", { notes: "x" });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /v1/categories/:slug (validateJson)", () => {
  async function patch(slug: string, body: unknown): Promise<Response> {
    return taxonomyRoutes.request(
      `/categories/${slug}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
      makeEnv(),
    );
  }

  test("upserts the name override", async () => {
    const res = await patch("ai", { name: "Artificial Intelligence" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string; name: string };
    expect(body.slug).toBe("ai");
    expect(body.name).toBe("Artificial Intelligence");

    const [row] = await testDb.db.select().from(categories).where(eq(categories.slug, "ai"));
    expect(row?.name).toBe("Artificial Intelligence");
  });

  test("normalizes aliases and persists them", async () => {
    const res = await patch("ai", { aliases: [" Machine-Learning ", "ml"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { aliases: string[] };
    expect(body.aliases.toSorted()).toEqual(["machine-learning", "ml"]);
  });

  test("400 when body is empty (refinement)", async () => {
    const res = await patch("ai", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.message.toLowerCase()).toContain("at least one");
  });

  test("400 when name exceeds 200 chars (schema bound)", async () => {
    const res = await patch("ai", { name: "x".repeat(201) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("400 when description exceeds 2000 chars (schema bound)", async () => {
    const res = await patch("ai", { description: "x".repeat(2001) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("400 when an alias element is not a string (schema bound)", async () => {
    const res = await patch("ai", { aliases: ["ok", 123] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("400 when alias shadows a canonical slug (handler check still runs)", async () => {
    const res = await patch("ai", { aliases: ["commerce"] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; type: string; message: string } };
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("canonical category slug");
  });

  test("404 when slug isn't a canonical category", async () => {
    const res = await patch("not-a-category", { name: "Whatever" });
    expect(res.status).toBe(404);
  });
});

describe("PUT /v1/errata/:orgId (validateJson)", () => {
  async function put(
    orgId: string,
    body: unknown,
    extra: Record<string, unknown> = {},
  ): Promise<Response> {
    return errataRoutes.request(
      `/errata/${orgId}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
      makeEnv(extra),
    );
  }

  test("400 bad_request when orgId lacks the org_ prefix", async () => {
    // Validator passes (content is fine); handler rejects the orgId shape.
    const res = await put("acme", { content: "foo" }, { MEMORY_STORE_ERRATA_ID: "store_x" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; type: string; message: string } };
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("org_");
  });

  test("400 bad_request when content is missing", async () => {
    const res = await put("org_acme", {}, { MEMORY_STORE_ERRATA_ID: "store_x" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.message.toLowerCase()).toContain("content");
  });

  test("400 bad_request when content is empty string", async () => {
    const res = await put("org_acme", { content: "" }, { MEMORY_STORE_ERRATA_ID: "store_x" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  test("400 payload_too_large when content exceeds the byte cap", async () => {
    // 100_001 ASCII chars = 100_001 UTF-8 bytes — crosses MAX_CONTENT_BYTES.
    // Route-level normalization: payload_too_large is 413 -> 400 (see design spec).
    const oversize = "x".repeat(100_001);
    const res = await put("org_acme", { content: oversize }, { MEMORY_STORE_ERRATA_ID: "store_x" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("payload_too_large");
  });

  test("500 internal_error when MEMORY_STORE_ERRATA_ID is unset", async () => {
    const res = await put("org_acme", { content: "valid" }, {});
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("internal_error");
  });
});
