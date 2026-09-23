/**
 * Tests for GET /v1/admin/embed/status.
 * Verifies the telemetry endpoint reports correct counts.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import { organizations, products, sources, releases } from "@buildinternet/releases-core/schema";

const { Hono } = await import("hono");
const { adminEmbedStatusRoutes } = await import("../src/routes/admin-embed-status.js");

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

function mkApp(db: ReturnType<typeof mkDb>) {
  const fakeEnv = { DB: db };
  const app = new Hono();
  const v1 = new Hono();
  v1.route("/", adminEmbedStatusRoutes);
  app.route("/v1", v1);
  return (req: Request) => app.fetch(req, fakeEnv);
}

describe("GET /v1/admin/embed/status", () => {
  it("returns zero counts on an empty DB", async () => {
    const db = mkDb();
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/admin/embed/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      releases: { total: number; embedded: number; unembedded: number };
      entities: {
        total: number;
        embedded: number;
        unembedded: number;
        breakdown?: Record<string, { total: number; embedded: number; unembedded: number }>;
      };
      chunks: { total: number; embedded: number; unembedded: number };
    };
    expect(body.releases).toEqual({ total: 0, embedded: 0, unembedded: 0 });
    expect(body.entities).toEqual({
      total: 0,
      embedded: 0,
      unembedded: 0,
      breakdown: {
        org: { total: 0, embedded: 0, unembedded: 0 },
        product: { total: 0, embedded: 0, unembedded: 0 },
        source: { total: 0, embedded: 0, unembedded: 0 },
      },
    });
    expect(body.chunks).toEqual({ total: 0, embedded: 0, unembedded: 0 });
  });

  it("correctly counts embedded vs unembedded releases", async () => {
    const db = mkDb();
    const now = new Date().toISOString();
    await db
      .insert(organizations)
      .values({ id: "org_1", slug: "acme", name: "Acme", category: "cloud" });
    await db.insert(sources).values({
      id: "src_1",
      orgId: "org_1",
      slug: "acme-src",
      name: "Acme Source",
      url: "https://acme.test/changelog",
      type: "feed",
    });
    await db.insert(releases).values([
      {
        id: "rel_1",
        sourceId: "src_1",
        title: "v1",
        content: "c1",
        url: "https://a.test/1",
        publishedAt: now,
        fetchedAt: now,
        contentHash: "h1",
        embeddedAt: now,
      },
      {
        id: "rel_2",
        sourceId: "src_1",
        title: "v2",
        content: "c2",
        url: "https://a.test/2",
        publishedAt: now,
        fetchedAt: now,
        contentHash: "h2",
      },
    ]);

    const fetch = mkApp(db);
    const res = await fetch(new Request("https://x.test/v1/admin/embed/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      releases: { total: number; embedded: number; unembedded: number };
    };
    expect(body.releases.total).toBe(2);
    expect(body.releases.embedded).toBe(1);
    expect(body.releases.unembedded).toBe(1);
  });

  it("aggregates entity counts across orgs, products, and sources", async () => {
    const db = mkDb();
    const now = new Date().toISOString();
    await db.insert(organizations).values([
      { id: "org_1", slug: "acme", name: "Acme", category: "cloud", embeddedAt: now },
      { id: "org_2", slug: "beta", name: "Beta", category: "ai" },
    ]);
    await db.insert(products).values({
      id: "prod_1",
      orgId: "org_1",
      slug: "acme-prod",
      name: "Acme Product",
      category: "cloud",
    });
    await db.insert(sources).values({
      id: "src_1",
      orgId: "org_1",
      slug: "acme-src",
      name: "Acme Source",
      url: "https://acme.test/changelog",
      type: "feed",
      embeddedAt: now,
    });

    const fetch = mkApp(db);
    const res = await fetch(new Request("https://x.test/v1/admin/embed/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entities: {
        total: number;
        embedded: number;
        unembedded: number;
        breakdown: {
          org: { total: number; embedded: number; unembedded: number };
          product: { total: number; embedded: number; unembedded: number };
          source: { total: number; embedded: number; unembedded: number };
        };
      };
    };
    expect(body.entities.total).toBe(4); // 2 orgs + 1 product + 1 source
    expect(body.entities.embedded).toBe(2); // org_1 + src_1
    expect(body.entities.unembedded).toBe(2); // org_2 + prod_1
    expect(body.entities.breakdown.org).toEqual({ total: 2, embedded: 1, unembedded: 1 });
    expect(body.entities.breakdown.product).toEqual({ total: 1, embedded: 0, unembedded: 1 });
    expect(body.entities.breakdown.source).toEqual({ total: 1, embedded: 1, unembedded: 0 });
  });
});
