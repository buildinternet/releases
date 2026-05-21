import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { getLatestReleasesAcross } from "../src/queries/releases";
import { applyMigrations, makeD1Shim } from "../../../tests/db-helper";
import { orgRoutes } from "../src/routes/orgs.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

async function seedLatest(): Promise<D1Database> {
  const sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  const db = drizzle(sqlite);
  await db.insert(organizations).values([
    { id: "org_visible", slug: "visible-org", name: "Visible" },
    { id: "org_hidden", slug: "hidden-org", name: "Hidden", isHidden: true },
  ]);
  await db.insert(sources).values([
    {
      id: "src_visible",
      slug: "visible-src",
      name: "Visible Src",
      type: "feed",
      url: "https://visible.example/feed",
      orgId: "org_visible",
    },
    {
      id: "src_hidden",
      slug: "hidden-src",
      name: "Hidden Src",
      type: "feed",
      url: "https://hidden.example/feed",
      orgId: "org_hidden",
    },
  ]);
  await db.insert(releases).values([
    {
      id: "rel_visible",
      sourceId: "src_visible",
      title: "Visible 1.0",
      content: "x",
      url: "https://visible.example/r/1",
      publishedAt: "2026-05-05T12:00:00.000Z",
    },
    {
      id: "rel_hidden",
      sourceId: "src_hidden",
      title: "Hidden 1.0",
      content: "x",
      url: "https://hidden.example/r/1",
      publishedAt: "2026-05-06T12:00:00.000Z",
    },
  ]);
  return makeD1Shim(sqlite);
}

describe("getLatestReleasesAcross — hidden-org filter", () => {
  it("excludes releases whose org is hidden", async () => {
    const d1 = await seedLatest();
    const rows = await getLatestReleasesAcross(d1, { limit: 50 });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("rel_visible");
    expect(ids).not.toContain("rel_hidden");
  });
});

// ── GET /v1/orgs directory filter (Task 3) ──

const mkApp = (db: ReturnType<typeof mkDb>) => createTestApp(db, orgRoutes);
const NOW = "2026-05-15T12:00:00.000Z";

async function seedDirectory(db: ReturnType<typeof mkDb>) {
  await db.insert(organizations).values([
    { id: "org_acme", slug: "acme", name: "Acme" },
    { id: "org_koute", slug: "koute", name: "Koute", isHidden: true },
  ]);
  await db.insert(sources).values([
    {
      id: "src_acme",
      orgId: "org_acme",
      slug: "acme-changelog",
      name: "Acme Changelog",
      type: "scrape",
      url: "https://acme.example/changelog",
      createdAt: NOW,
    },
    {
      id: "src_koute",
      orgId: "org_koute",
      slug: "koute-changelog",
      name: "Koute Changelog",
      type: "scrape",
      url: "https://koute.example/changelog",
      createdAt: NOW,
    },
  ]);
  await db.insert(releases).values([
    {
      id: "rel_acme_1",
      sourceId: "src_acme",
      title: "Acme 1.0",
      content: "x",
      publishedAt: NOW,
      fetchedAt: NOW,
    },
    {
      id: "rel_koute_1",
      sourceId: "src_koute",
      title: "Koute 1.0",
      content: "x",
      publishedAt: NOW,
      fetchedAt: NOW,
    },
  ]);
}

describe("GET /v1/orgs — hidden-org filter", () => {
  it("excludes hidden orgs from items and totalItems", async () => {
    const db = mkDb();
    await seedDirectory(db);

    const res = await mkApp(db)(new Request("https://x.test/v1/orgs"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ slug: string }>;
      pagination: { totalItems: number };
    };
    expect(body.items.map((o) => o.slug)).toEqual(["acme"]);
    expect(body.pagination.totalItems).toBe(1);
  });

  it("keeps hidden orgs out even with ?includeEmpty=true", async () => {
    const db = mkDb();
    await seedDirectory(db);

    const res = await mkApp(db)(new Request("https://x.test/v1/orgs?includeEmpty=true"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ slug: string }> };
    expect(body.items.map((o) => o.slug)).not.toContain("koute");
  });
});
