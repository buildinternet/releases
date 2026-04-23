import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { applyMigrations } from "../db-helper";
import {
  organizations,
  sources,
  releases,
  knowledgePages,
} from "@buildinternet/releases-core/schema";
import overviewInputs from "../../workers/api/src/routes/overview-inputs";
import { newKnowledgePageId } from "../../workers/api/src/utils";

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

function mkApp(db: ReturnType<typeof mkDb>, env: Record<string, unknown> = {}) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as any).set("db", db);
    (c as any).env = { ...(c as any).env, ...env };
    await next();
  });
  app.route("/", overviewInputs);
  return app;
}

describe("GET /v1/orgs/:slug/overview/inputs", () => {
  let db: ReturnType<typeof mkDb>;
  let orgId: string;
  let srcGithubId: string;
  let srcScrapeId: string;

  beforeEach(async () => {
    db = mkDb();

    const [org] = await db
      .insert(organizations)
      .values({ name: "Acme", slug: "acme", description: "Test org" })
      .returning();
    orgId = org.id;

    const [srcA] = await db
      .insert(sources)
      .values({
        orgId,
        name: "Acme GH",
        slug: "acme-gh",
        type: "github",
        url: "https://github.com/acme/x",
      })
      .returning();
    srcGithubId = srcA.id;

    const [srcB] = await db
      .insert(sources)
      .values({
        orgId,
        name: "Acme Site",
        slug: "acme-site",
        type: "scrape",
        url: "https://acme.com/changelog",
      })
      .returning();
    srcScrapeId = srcB.id;

    // Hidden source — must not appear
    await db.insert(sources).values({
      orgId,
      name: "Hidden",
      slug: "acme-hidden",
      type: "feed",
      url: "https://acme.com/hidden.xml",
      isHidden: true,
    });

    // Paused source — must not appear
    await db.insert(sources).values({
      orgId,
      name: "Paused",
      slug: "acme-paused",
      type: "feed",
      url: "https://acme.com/paused.xml",
      fetchPriority: "paused",
    });
  });

  it("returns org, active sources, selected releases, and totals", async () => {
    // 15 github releases (cap = 10) and 25 scrape releases (cap = 20)
    const now = Date.now();
    const ghRows = Array.from({ length: 15 }, (_, i) => ({
      id: `rel_gh_${i}`,
      sourceId: srcGithubId,
      title: `gh ${i}`,
      url: `https://github.com/acme/x/releases/${i}`,
      content: "x",
      publishedAt: new Date(now - i * 86400_000).toISOString(),
    }));
    const scRows = Array.from({ length: 25 }, (_, i) => ({
      id: `rel_sc_${i}`,
      sourceId: srcScrapeId,
      title: `sc ${i}`,
      url: `https://acme.com/changelog#${i}`,
      content: "x",
      publishedAt: new Date(now - i * 86400_000).toISOString(),
    }));
    await db.insert(releases).values([...ghRows, ...scRows]);

    const app = mkApp(db);
    const res = await app.request("/orgs/acme/overview/inputs?window=365");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      org: { slug: string };
      sources: Array<{ slug: string }>;
      selected: Array<{ id: string }>;
      totalAvailable: number;
      windowDays: number;
      existingContent: string | null;
    };

    expect(body.org.slug).toBe("acme");
    expect(body.sources.map((s) => s.slug).toSorted()).toEqual(["acme-gh", "acme-site"]);
    expect(body.totalAvailable).toBe(40);
    // github capped at 10 + scrape capped at 20 = 30 selected
    expect(body.selected.length).toBe(30);
    expect(body.windowDays).toBe(365);
    expect(body.existingContent).toBeNull();
  });

  it("includes existingContent when an overview row exists", async () => {
    await db.insert(knowledgePages).values({
      id: newKnowledgePageId(),
      scope: "org",
      orgId,
      content: "previous overview body",
      releaseCount: 12,
    });

    const app = mkApp(db);
    const res = await app.request("/orgs/acme/overview/inputs");
    const body = (await res.json()) as { existingContent: string | null };
    expect(body.existingContent).toBe("previous overview body");
  });

  it("returns empty selection when no releases land in the window", async () => {
    // Single ancient release outside the default 90-day window
    await db.insert(releases).values({
      id: "rel_old",
      sourceId: srcGithubId,
      title: "old",
      url: "https://github.com/acme/x/releases/old",
      content: "x",
      publishedAt: "2000-01-01T00:00:00.000Z",
    });

    const app = mkApp(db);
    const res = await app.request("/orgs/acme/overview/inputs");
    const body = (await res.json()) as {
      selected: unknown[];
      totalAvailable: number;
    };
    expect(body.selected).toEqual([]);
    expect(body.totalAvailable).toBe(0);
  });

  it("404s on missing org", async () => {
    const app = mkApp(db);
    const res = await app.request("/orgs/nope/overview/inputs");
    expect(res.status).toBe(404);
  });

  it("400s on invalid window param", async () => {
    const app = mkApp(db);
    const res = await app.request("/orgs/acme/overview/inputs?window=-1");
    expect(res.status).toBe(400);
  });

  it("hydrates media and content URLs on selected releases", async () => {
    const now = Date.now();
    await db.insert(releases).values({
      id: "rel_media",
      sourceId: srcGithubId,
      title: "demo",
      url: "https://github.com/acme/x/releases/demo",
      content: "See ![shot](/_media/shots/a.png) for details.",
      media: JSON.stringify([
        { type: "image", url: "https://orig.example.com/a.png", alt: "shot", r2Key: "shots/a.png" },
      ]),
      publishedAt: new Date(now - 1 * 86400_000).toISOString(),
    });

    const app = mkApp(db, { MEDIA_ORIGIN: "https://cdn.example.com" });
    const res = await app.request("/orgs/acme/overview/inputs?window=365");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      selected: Array<{
        id: string;
        content: string;
        media: Array<{ type: string; url: string; alt?: string; r2Url?: string }>;
      }>;
    };

    const [rel] = body.selected;
    expect(rel.id).toBe("rel_media");
    expect(rel.content).toContain("https://cdn.example.com/");
    expect(rel.content).not.toContain("/_media/");
    expect(rel.media).toHaveLength(1);
    expect(rel.media[0].r2Url).toBe("https://cdn.example.com/shots/a.png");
    expect(rel.media[0].alt).toBe("shot");
  });
});
