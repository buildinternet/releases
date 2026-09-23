// Smoke tests for POST /v1/workflows/batch-enrich — the dispatch wiring + gates.
// The deep enrichment logic (candidate selection, batch-request construction,
// result→upsert mapping) is unit-tested in tests/unit/enrich-apply.test.ts and
// tests/unit/enrich-batch.test.ts; this file only proves the HTTP layer.
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import { organizations, sources } from "@buildinternet/releases-core/schema";

const { Hono } = await import("hono");
const { workflowsRoutes } = await import("../src/routes/workflows.js");

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  sqlite.exec("DELETE FROM collections");
  return db;
}

/** Records the params the workflow binding was created with. */
function mkWorkflowBinding() {
  const calls: Array<{ id?: string; params: unknown }> = [];
  return {
    calls,
    binding: {
      create: async (opts: { id?: string; params: unknown }) => {
        calls.push(opts);
        return { id: "wfi_batch_enrich_1" };
      },
    },
  };
}

function mkApp(db: ReturnType<typeof mkDb>, extra: Record<string, unknown> = {}) {
  const fakeEnv = { DB: db, ...extra };
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", workflowsRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, fakeEnv);
}

async function seedSources(db: ReturnType<typeof mkDb>): Promise<void> {
  await db
    .insert(organizations)
    .values({ id: "org_a", slug: "acme", name: "Acme", category: "developer-tools" });
  await db.insert(sources).values([
    {
      id: "src_one",
      orgId: "org_a",
      slug: "acme-blog",
      name: "Acme Blog",
      type: "feed",
      url: "https://acme.test/blog",
    },
    {
      id: "src_two",
      orgId: "org_a",
      slug: "acme-news",
      name: "Acme News",
      type: "feed",
      url: "https://acme.test/news",
    },
  ]);
}

function post(fetch: (r: Request) => Response | Promise<Response>, body: unknown) {
  return fetch(
    new Request("https://x.test/v1/workflows/batch-enrich", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /v1/workflows/batch-enrich", () => {
  it("400 when sourceIds is missing or empty", async () => {
    const db = mkDb();
    await seedSources(db);
    const { binding } = mkWorkflowBinding();
    const fetch = mkApp(db, { BATCH_ENRICH_WORKFLOW: binding });

    const res = await post(fetch, {});
    expect(res.status).toBe(400);
    expect(
      (
        (await res.json()) as {
          error?: { code: string; type: string; message: string };
        }
      ).error?.code,
    ).toBe("bad_request");

    const res2 = await post(fetch, { sourceIds: [] });
    expect(res2.status).toBe(400);
  });

  it("400 bare_slug_rejected when a sourceId is not a typed src_ id", async () => {
    const db = mkDb();
    await seedSources(db);
    const { binding } = mkWorkflowBinding();
    const fetch = mkApp(db, { BATCH_ENRICH_WORKFLOW: binding });

    const res = await post(fetch, { sourceIds: ["acme-blog"] });
    expect(res.status).toBe(400);
    expect(
      (
        (await res.json()) as {
          error?: { code: string; type: string; message: string };
        }
      ).error?.code,
    ).toBe("bare_slug_rejected");
  });

  it("404 when a targeted source does not exist", async () => {
    const db = mkDb();
    await seedSources(db);
    const { binding } = mkWorkflowBinding();
    const fetch = mkApp(db, { BATCH_ENRICH_WORKFLOW: binding });

    const res = await post(fetch, { sourceIds: ["src_one", "src_missing"] });
    expect(res.status).toBe(404);
  });

  it("503 when the workflow binding is not configured", async () => {
    const db = mkDb();
    await seedSources(db);
    const fetch = mkApp(db); // no BATCH_ENRICH_WORKFLOW

    const res = await post(fetch, { sourceIds: ["src_one"] });
    expect(res.status).toBe(503);
  });

  it("202 dispatches the workflow with the resolved sourceIds + options", async () => {
    const db = mkDb();
    await seedSources(db);
    const { binding, calls } = mkWorkflowBinding();
    const fetch = mkApp(db, { BATCH_ENRICH_WORKFLOW: binding });

    const res = await post(fetch, {
      sourceIds: ["src_one", "src_two"],
      limit: 25,
      dryRun: true,
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { async?: boolean; instanceId?: string };
    expect(body.async).toBe(true);
    expect(body.instanceId).toBe("wfi_batch_enrich_1");

    expect(calls).toHaveLength(1);
    expect(calls[0].params).toMatchObject({
      sourceIds: ["src_one", "src_two"],
      limit: 25,
      dryRun: true,
    });
  });
});
