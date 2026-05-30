// Smoke tests for POST /v1/workflows/backfill-source.
//
// Covers the gates (typed-id, 404, non-scrape, 503-no-key) and a supplied-
// markdown dry-run via the `_backfillExtractOverride` test hook. The deep
// extract/ingest logic is unit-tested in source-backfill.test.ts and
// firecrawl-extract.test.ts; this file only proves the HTTP wiring.
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

function post(fetch: (r: Request) => Response | Promise<Response>, body: unknown) {
  return fetch(
    new Request("https://x.test/v1/workflows/backfill-source", {
      method: "POST",
      body: JSON.stringify(body),
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
});
