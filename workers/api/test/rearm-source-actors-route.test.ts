/**
 * POST /v1/workflows/rearm-source-actors (#2286) — one source or fleet sweep.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { workflowsRoutes } from "../src/routes/workflows.js";
import { respondError } from "../src/lib/error-response.js";
import { createTestDb } from "./setup";

function mkApp(db: ReturnType<typeof createTestDb>, extra: Record<string, unknown> = {}) {
  const ensured: Array<{ id: string; force?: boolean }> = [];
  const fakeEnv = {
    DB: db,
    SOURCE_ACTOR: {
      getByName: (id: string) => ({
        ensureScheduled: async (sourceId: string, opts?: { force?: boolean }) => {
          ensured.push({ id: sourceId, force: opts?.force });
          expect(id).toBe(sourceId);
        },
      }),
    },
    ...extra,
  };
  const app = new Hono();
  app.onError((err, c) => respondError(c, err));
  const v1 = new Hono();
  v1.route("/", workflowsRoutes);
  app.route("/v1", v1);
  return {
    ensured,
    fetch: (body: unknown) =>
      app.fetch(
        new Request("https://x.test/v1/workflows/rearm-source-actors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        fakeEnv,
      ),
  };
}

describe("POST /v1/workflows/rearm-source-actors", () => {
  it("400 without sourceId or all", async () => {
    const { fetch } = mkApp(createTestDb());
    const res = await fetch({});
    expect(res.status).toBe(400);
  });

  it("400 on a bare slug", async () => {
    const { fetch } = mkApp(createTestDb());
    const res = await fetch({ sourceId: "anthropic-news" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bare_slug_rejected");
  });

  it("force-arms a single typed source", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({
      id: "org_a",
      slug: "acme",
      name: "Acme",
    });
    await db.insert(sources).values({
      id: "src_news",
      orgId: "org_a",
      slug: "news",
      name: "News",
      type: "scrape",
      url: "https://example.com/news",
      fetchPriority: "normal",
    });
    const { fetch, ensured } = mkApp(db);
    const res = await fetch({ sourceId: "src_news" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dryRun: boolean;
      armed: number;
      requested: number;
      items: Array<{ sourceId: string; reason: string }>;
    };
    expect(body.dryRun).toBe(false);
    expect(body.requested).toBe(1);
    expect(body.armed).toBe(1);
    expect(body.items[0]).toMatchObject({ sourceId: "src_news", reason: "requested" });
    expect(ensured).toEqual([{ id: "src_news", force: true }]);
  });

  it("dry-run fleet sweep lists unmanaged sources without arming", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({
      id: "org_a",
      slug: "acme",
      name: "Acme",
    });
    await db.insert(sources).values({
      id: "src_dead",
      orgId: "org_a",
      slug: "dead",
      name: "Dead",
      type: "scrape",
      url: "https://example.com/dead",
      fetchPriority: "normal",
      metadata: JSON.stringify({
        sourceActor: { managed: false, nextAlarmAt: null, lastAlarmAt: "2026-07-01T00:00:00.000Z" },
      }),
    });
    const { fetch, ensured } = mkApp(db);
    const res = await fetch({ all: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dryRun: boolean;
      armed: number;
      requested: number;
      items: Array<{ sourceId: string; reason: string }>;
    };
    expect(body.dryRun).toBe(true);
    expect(body.armed).toBe(0);
    expect(body.requested).toBe(1);
    expect(body.items[0]).toMatchObject({ sourceId: "src_dead", reason: "unmanaged" });
    expect(ensured).toEqual([]);
  });

  it("all + dryRun:false arms unmanaged sources", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({
      id: "org_a",
      slug: "acme",
      name: "Acme",
    });
    await db.insert(sources).values({
      id: "src_dead",
      orgId: "org_a",
      slug: "dead",
      name: "Dead",
      type: "scrape",
      url: "https://example.com/dead",
      fetchPriority: "normal",
      metadata: JSON.stringify({
        sourceActor: { managed: false, nextAlarmAt: null, lastAlarmAt: "2026-07-01T00:00:00.000Z" },
      }),
    });
    const { fetch, ensured } = mkApp(db);
    const res = await fetch({ all: true, dryRun: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dryRun: boolean; armed: number };
    expect(body.dryRun).toBe(false);
    expect(body.armed).toBe(1);
    expect(ensured).toEqual([{ id: "src_dead", force: true }]);
  });
});
