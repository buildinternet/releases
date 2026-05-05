/**
 * Tests for #699 Phase D step 5: source_slug is gone; usage_log only carries
 * source_id. The POST handler still accepts sourceSlug for back-compat (it
 * resolves to sourceId when unambiguous and otherwise drops it on the floor).
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations } from "../../../tests/db-helper";
import { organizations, sources, usageLog } from "@buildinternet/releases-core/schema";

function mkDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=ON");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return { db, sqlite };
}

async function makeApp(db: ReturnType<typeof mkDb>["db"]) {
  const { Hono } = await import("hono");
  const { usageLogRoutes } = await import("../src/routes/usage-log.js");
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", usageLogRoutes);
  app.route("/v1", v1);
  const fakeEnv = { DB: db };
  return (req: Request) => app.fetch(req, fakeEnv);
}

async function seed(db: ReturnType<typeof mkDb>["db"]) {
  await db.insert(organizations).values([
    { id: "org_a", slug: "acme", name: "Acme", category: "cloud" },
    { id: "org_b", slug: "beta", name: "Beta", category: "cloud" },
  ]);
  await db.insert(sources).values([
    {
      id: "src_a1",
      orgId: "org_a",
      slug: "my-tool",
      name: "My Tool (Acme)",
      url: "https://acme.test/changelog",
      type: "feed",
    },
    {
      id: "src_b1",
      orgId: "org_b",
      slug: "my-tool",
      name: "My Tool (Beta)",
      url: "https://beta.test/changelog",
      type: "feed",
    },
  ]);
}

describe("POST /v1/admin/logs/usage — sourceSlug → sourceId resolution", () => {
  it("resolves sourceSlug to sourceId when the slug uniquely identifies one source", async () => {
    const { db } = mkDb();
    await seed(db);
    // A third source with a unique slug — no cross-org collision.
    await db.insert(sources).values({
      id: "src_a2",
      orgId: "org_a",
      slug: "lone-tool",
      name: "Lone Tool",
      url: "https://acme.test/lone",
      type: "feed",
    });
    const fetch = await makeApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/admin/logs/usage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "agent-ingest",
          model: "claude-haiku-4-5",
          inputTokens: 1000,
          outputTokens: 200,
          sourceSlug: "lone-tool",
          releaseCount: 3,
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sourceId: string | null };
    expect(body.sourceId).toBe("src_a2");
  });

  it("leaves sourceId null when sourceSlug is ambiguous (matches multiple orgs)", async () => {
    const { db } = mkDb();
    // The default seed plants `my-tool` under both org_a and org_b — a real
    // per-org-uniqueness collision that the resolver must refuse to guess at.
    await seed(db);
    const fetch = await makeApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/admin/logs/usage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "agent-ingest",
          model: "claude-haiku-4-5",
          inputTokens: 1000,
          outputTokens: 200,
          sourceSlug: "my-tool",
          releaseCount: 3,
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sourceId: string | null };
    expect(body.sourceId).toBeNull();
  });

  it("accepts a pre-resolved sourceId without a slug round-trip", async () => {
    const { db } = mkDb();
    await seed(db);
    const fetch = await makeApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/admin/logs/usage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "agent-ingest",
          model: "claude-haiku-4-5",
          inputTokens: 500,
          outputTokens: 100,
          sourceId: "src_b1",
          releaseCount: 1,
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sourceId: string | null };
    expect(body.sourceId).toBe("src_b1");
  });

  it("leaves sourceId null when sourceSlug does not match any source", async () => {
    const { db } = mkDb();
    await seed(db);
    const fetch = await makeApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/admin/logs/usage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "agent-ingest",
          model: "claude-haiku-4-5",
          inputTokens: 100,
          outputTokens: 20,
          sourceSlug: "deleted-source",
          releaseCount: 0,
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sourceId: string | null };
    expect(body.sourceId).toBeNull();
  });
});

describe("GET /v1/admin/logs/usage/stats — bySource breakdown", () => {
  it("groups by sourceId and joins sources for the display slug", async () => {
    const { db } = mkDb();
    await seed(db);
    const fetch = await makeApp(db);

    await db.insert(usageLog).values({
      operation: "agent-ingest",
      model: "test-model",
      inputTokens: 100,
      outputTokens: 20,
      sourceId: "src_a1",
      releaseCount: 1,
    });

    const res = await fetch(new Request("https://x.test/v1/admin/logs/usage/stats?days=7"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bySource: Array<{ label: string | null; count: number }>;
    };

    expect(body.bySource).toHaveLength(1);
    expect(body.bySource[0].label).toBe("my-tool");
    expect(body.bySource[0].count).toBe(1);
  });

  it("excludes rows whose source has been soft-deleted (deletedAt set)", async () => {
    const { db } = mkDb();
    await seed(db);
    const fetch = await makeApp(db);

    // Tombstone src_a1 — it stays in the table but should fall out of the
    // bySource rollup since the route joins sources_active, not sources.
    await db
      .update(sources)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(sources.id, "src_a1"));

    await db.insert(usageLog).values({
      operation: "agent-ingest",
      model: "test-model",
      inputTokens: 100,
      outputTokens: 20,
      sourceId: "src_a1",
      releaseCount: 1,
    });

    const res = await fetch(new Request("https://x.test/v1/admin/logs/usage/stats?days=7"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: { count: number };
      bySource: Array<{ label: string | null; count: number }>;
    };

    expect(body.totals.count).toBe(1);
    expect(body.bySource).toHaveLength(0);
  });

  it("excludes rows whose source has been deleted (sourceId NULL)", async () => {
    const { db } = mkDb();
    await seed(db);
    const fetch = await makeApp(db);

    // sourceId NULL — simulates the row a source delete leaves behind via
    // the ON DELETE SET NULL FK. The row still contributes to totals but not
    // to the per-source breakdown.
    await db.insert(usageLog).values({
      operation: "agent-ingest",
      model: "test-model",
      inputTokens: 100,
      outputTokens: 20,
      sourceId: null,
      releaseCount: 1,
    });

    const res = await fetch(new Request("https://x.test/v1/admin/logs/usage/stats?days=7"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: { count: number };
      bySource: Array<{ label: string | null; count: number }>;
    };

    expect(body.totals.count).toBe(1);
    expect(body.bySource).toHaveLength(0);
  });
});
