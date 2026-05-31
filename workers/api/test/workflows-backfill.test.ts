// Smoke tests for POST /v1/workflows/backfill-source.
//
// Covers the gates (typed-id, 404, non-scrape, 503-no-key) and a supplied-
// markdown dry-run via the `_backfillExtractOverride` test hook. The deep
// extract/ingest logic is unit-tested in source-backfill.test.ts and
// firecrawl-extract.test.ts; this file only proves the HTTP wiring.
//
// Also covers the workflow dispatch path (Task 3.1):
// - workflow path returns 202 when flag on + firecrawl source + binding present
// - flag off → synchronous (200)
// - supplied markdown → synchronous even with flag on (200)
// - status GET passes through WorkflowInstance.status()
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

function mkApp(db: ReturnType<typeof mkDb>, extra: Record<string, unknown> = {}) {
  const fakeEnv = { DB: db, ...extra };
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", workflowsRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, fakeEnv);
}

async function seedScrapeSource(db: ReturnType<typeof mkDb>): Promise<void> {
  await db
    .insert(organizations)
    .values({ id: "org_a", slug: "acme", name: "Acme", category: "developer-tools" });
  await db.insert(sources).values({
    id: "src_scrape",
    orgId: "org_a",
    slug: "acme-blog",
    name: "Acme Blog",
    type: "scrape",
    url: "https://acme.test/changelog",
  });
}

async function seedFirecrawlSource(db: ReturnType<typeof mkDb>): Promise<void> {
  await db
    .insert(organizations)
    .values({ id: "org_fc", slug: "fcorp", name: "FCorp", category: "developer-tools" });
  await db.insert(sources).values({
    id: "src_fc",
    orgId: "org_fc",
    slug: "fcorp-blog",
    name: "FCorp Blog",
    type: "scrape",
    url: "https://fcorp.test/changelog",
    metadata: JSON.stringify({ firecrawl: { enabled: true } }),
  });
}

function post(fetch: (r: Request) => Response | Promise<Response>, body: unknown) {
  return fetch(
    new Request("https://x.test/v1/workflows/backfill-source", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

function getStatus(fetch: (r: Request) => Response | Promise<Response>, instanceId: string) {
  return fetch(
    new Request(`https://x.test/v1/workflows/backfill-source/status/${instanceId}`, {
      method: "GET",
    }),
  );
}

describe("POST /v1/workflows/backfill-source", () => {
  it("rejects a bare slug with bare_slug_rejected", async () => {
    const db = mkDb();
    await seedScrapeSource(db);
    const res = await post(mkApp(db), { sourceSlug: "acme-blog" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bare_slug_rejected");
  });

  it("404s an unknown source id", async () => {
    const db = mkDb();
    const res = await post(mkApp(db), { sourceId: "src_missing" });
    expect(res.status).toBe(404);
  });

  it("400s a non-scrape source", async () => {
    const db = mkDb();
    await db
      .insert(organizations)
      .values({ id: "org_g", slug: "gh", name: "GH", category: "developer-tools" });
    await db.insert(sources).values({
      id: "src_gh",
      orgId: "org_g",
      slug: "gh-src",
      name: "GH Source",
      type: "github",
      url: "https://github.com/gh/gh",
    });
    const res = await post(mkApp(db), { sourceId: "src_gh" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_request");
  });

  it("503s when no Anthropic key and no extract override", async () => {
    const db = mkDb();
    await seedScrapeSource(db);
    const res = await post(mkApp(db), {
      sourceId: "src_scrape",
      markdown: "# v1\nstuff",
      dryRun: true,
    });
    expect(res.status).toBe(503);
  });

  it("dryRun with supplied markdown reports deduped counts + date range", async () => {
    const db = mkDb();
    await seedScrapeSource(db);
    const override = async () => ({
      releases: [
        { title: "v1", content: "b", url: "https://x#a", publishedAt: new Date("2024-01-01") },
        { title: "v2", content: "b", url: "https://x#b", publishedAt: new Date("2024-03-01") },
        { title: "v1again", content: "b", url: "https://x#a" },
      ],
      windows: 1,
      cappedAtWindow: false,
      droppedChars: 0,
    });
    const fetch = mkApp(db, { _backfillExtractOverride: override });

    const res = await post(fetch, {
      sourceId: "src_scrape",
      markdown: "# v1\nstuff",
      dryRun: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      via: string;
      extracted: number;
      deduped: number;
      inserted: number;
      dryRun: boolean;
      dateRange: { from: string | null; to: string | null };
    };
    expect(body.via).toBe("supplied");
    expect(body.extracted).toBe(3);
    expect(body.deduped).toBe(2);
    expect(body.inserted).toBe(0);
    expect(body.dryRun).toBe(true);
    expect(body.dateRange.from).toBe("2024-01-01T00:00:00.000Z");
    expect(body.dateRange.to).toBe("2024-03-01T00:00:00.000Z");
  });

  it("does not clamp the supplied-markdown path and emits no guidance", async () => {
    const db = mkDb();
    await seedScrapeSource(db);
    let seenMaxWindows = -1;
    const override = async (_md: string, _src: unknown, maxWindows: number) => {
      seenMaxWindows = maxWindows;
      return { releases: [], windows: 1, cappedAtWindow: false, droppedChars: 0 };
    };
    const fetch = mkApp(db, { _backfillExtractOverride: override });

    const res = await post(fetch, {
      sourceId: "src_scrape",
      markdown: "# v1\nstuff",
      maxWindows: 50,
      dryRun: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { via: string; guidance?: string };
    expect(body.via).toBe("supplied");
    expect(seenMaxWindows).toBe(50);
    expect(body.guidance).toBeUndefined();
  });

  it("clamps the firecrawl path to the hard ceiling and emits guidance", async () => {
    const db = mkDb();
    await seedScrapeSource(db);
    let seenMaxWindows = -1;
    const override = async (_md: string, _src: unknown, maxWindows: number) => {
      seenMaxWindows = maxWindows;
      // Report a capped run with untouched tail so guidance fires.
      return { releases: [], windows: maxWindows, cappedAtWindow: true, droppedChars: 999 };
    };
    const fetch = mkApp(db, {
      _backfillExtractOverride: override,
      _backfillBodyOverride: { markdown: "# lots of history", via: "firecrawl" },
    });

    const res = await post(fetch, {
      sourceId: "src_scrape",
      maxWindows: 50,
      dryRun: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { via: string; guidance?: string };
    expect(body.via).toBe("firecrawl");
    expect(seenMaxWindows).toBe(8);
    expect(body.guidance).toContain("8 windows");
  });
});

// ── Workflow dispatch tests (Task 3.1) ────────────────────────────────────────

describe("POST /v1/workflows/backfill-source → workflow path", () => {
  it("returns 202 with instanceId when firecrawl source + flag on + binding present", async () => {
    const db = mkDb();
    await seedFirecrawlSource(db);

    const created: Array<{ id: string; params: unknown }> = [];
    const fakeWorkflow = {
      create: async ({ id, params }: { id: string; params: unknown }) => {
        created.push({ id, params });
        return { id };
      },
    };

    const fetch = mkApp(db, {
      BACKFILL_WORKFLOW_ENABLED: "true",
      BACKFILL_SOURCE_WORKFLOW: fakeWorkflow,
    });

    const res = await post(fetch, { sourceId: "src_fc", dryRun: true });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { instanceId: string; async: boolean; statusUrl?: string };
    expect(body.instanceId).toBeDefined();
    expect(body.async).toBe(true);

    // Workflow was invoked with correct params; no Firecrawl scrape occurred
    // (there's no FIRECRAWL_API_KEY in env — if the route tried to scrape it
    // would return 503, not 202).
    expect(created).toHaveLength(1);
    const p = created[0]!.params as { sourceId: string; dryRun: boolean; maxWindows: number };
    expect(p.sourceId).toBe("src_fc");
    expect(p.dryRun).toBe(true);
    expect(typeof p.maxWindows).toBe("number");
  });

  it("returns 200 synchronous when flag off (firecrawl source, no flag env)", async () => {
    const db = mkDb();
    await seedFirecrawlSource(db);

    const override = async () => ({
      releases: [],
      windows: 1,
      cappedAtWindow: false,
      droppedChars: 0,
    });

    const fetch = mkApp(db, {
      // BACKFILL_WORKFLOW_ENABLED intentionally omitted → flag defaults to false
      _backfillExtractOverride: override,
      _backfillBodyOverride: { markdown: "# changelog", via: "firecrawl" },
    });

    const res = await post(fetch, { sourceId: "src_fc", dryRun: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { via: string };
    expect(body.via).toBe("firecrawl");
  });

  it("returns 200 synchronous when markdown supplied even with flag on", async () => {
    const db = mkDb();
    await seedFirecrawlSource(db);

    const override = async () => ({
      releases: [],
      windows: 1,
      cappedAtWindow: false,
      droppedChars: 0,
    });

    const fakeWorkflow = {
      create: async () => {
        throw new Error("should not be called");
      },
    };

    const fetch = mkApp(db, {
      BACKFILL_WORKFLOW_ENABLED: "true",
      BACKFILL_SOURCE_WORKFLOW: fakeWorkflow,
      _backfillExtractOverride: override,
    });

    // markdown supplied → fast path, no workflow dispatch
    const res = await post(fetch, {
      sourceId: "src_fc",
      markdown: "# v1\nstuff",
      dryRun: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { via: string };
    expect(body.via).toBe("supplied");
  });
});

describe("GET /v1/workflows/backfill-source/status/:instanceId", () => {
  it("returns 200 with status from WorkflowInstance.status()", async () => {
    const db = mkDb();

    const fakeWorkflow = {
      get: async (_id: string) => ({
        status: async () => ({ status: "complete", output: { inserted: 5 } }),
      }),
    };

    const fetch = mkApp(db, { BACKFILL_SOURCE_WORKFLOW: fakeWorkflow });
    const res = await getStatus(fetch, "backfill-src_fc-12345");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { instanceId: string; status: string; output: unknown };
    expect(body.instanceId).toBe("backfill-src_fc-12345");
    expect(body.status).toBe("complete");
  });

  it("returns 503 when binding is missing", async () => {
    const db = mkDb();
    const fetch = mkApp(db, {}); // no BACKFILL_SOURCE_WORKFLOW
    const res = await getStatus(fetch, "backfill-src_fc-99999");
    expect(res.status).toBe(503);
  });

  it("returns 404 when instance does not exist", async () => {
    const db = mkDb();

    const fakeWorkflow = {
      get: async (_id: string) => {
        throw new Error("Instance not found");
      },
    };

    const fetch = mkApp(db, { BACKFILL_SOURCE_WORKFLOW: fakeWorkflow });
    const res = await getStatus(fetch, "backfill-nonexistent");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("instance_not_found");
  });
});
