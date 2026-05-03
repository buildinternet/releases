/**
 * Tests for #699 Phase D: dual-write source_id alongside source_slug on
 * usage_log, and the read path that groups by source_id with a slug fallback.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import { organizations, sources, usageLog } from "@buildinternet/releases-core/schema";

function mkDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=ON");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return { db, sqlite };
}

// Lightweight HTTP harness that exercises the actual Hono routes.
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

describe("POST /v1/admin/logs/usage — dual-write source_id", () => {
  it("populates source_id when the slug uniquely identifies one source", async () => {
    const { db } = mkDb();
    await seed(db);
    // Insert a third source with a unique slug (no cross-org collision).
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
    const body = (await res.json()) as { sourceSlug: string | null; sourceId: string | null };
    expect(body.sourceSlug).toBe("lone-tool");
    expect(body.sourceId).toBe("src_a2");
  });

  it("leaves source_id null when slug is ambiguous (matches multiple orgs)", async () => {
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
    const body = (await res.json()) as { sourceSlug: string | null; sourceId: string | null };
    expect(body.sourceSlug).toBe("my-tool");
    expect(body.sourceId).toBeNull();
  });

  it("accepts a pre-resolved source_id without a slug round-trip", async () => {
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
          sourceSlug: null,
          sourceId: "src_b1",
          releaseCount: 1,
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sourceSlug: string | null; sourceId: string | null };
    expect(body.sourceId).toBe("src_b1");
    expect(body.sourceSlug).toBeNull();
  });

  it("leaves source_id null when slug does not match any source", async () => {
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
    const body = (await res.json()) as { sourceSlug: string | null; sourceId: string | null };
    expect(body.sourceSlug).toBe("deleted-source");
    expect(body.sourceId).toBeNull();
  });
});

describe("GET /v1/admin/logs/usage/stats — read path with source_id", () => {
  it("includes rows with only source_id set (post-backfill state)", async () => {
    const { db } = mkDb();
    await seed(db);
    const fetch = await makeApp(db);

    // Insert a row with source_id but no source_slug (simulates post-drop state)
    await db.insert(usageLog).values({
      operation: "agent-ingest",
      model: "test-model",
      inputTokens: 100,
      outputTokens: 20,
      sourceSlug: null,
      sourceId: "src_a1",
      releaseCount: 1,
    });

    const res = await fetch(new Request("https://x.test/v1/admin/logs/usage/stats?days=7"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bySource: Array<{ label: string | null; count: number }>;
    };

    // The row with source_id = src_a1 should appear in bySource with the slug
    // resolved via JOIN (my-tool for acme/my-tool = src_a1)
    expect(body.bySource).toHaveLength(1);
    expect(body.bySource[0].label).toBe("my-tool");
    expect(body.bySource[0].count).toBe(1);
  });

  it("falls back to source_slug for legacy rows without source_id", async () => {
    const { db } = mkDb();
    await seed(db);
    const fetch = await makeApp(db);

    // Insert a legacy row with source_slug only (pre-backfill state)
    await db.insert(usageLog).values({
      operation: "agent-ingest",
      model: "test-model",
      inputTokens: 100,
      outputTokens: 20,
      sourceSlug: "legacy-slug",
      sourceId: null,
      releaseCount: 1,
    });

    const res = await fetch(new Request("https://x.test/v1/admin/logs/usage/stats?days=7"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bySource: Array<{ label: string | null; count: number }>;
    };

    expect(body.bySource).toHaveLength(1);
    expect(body.bySource[0].label).toBe("legacy-slug");
  });
});
