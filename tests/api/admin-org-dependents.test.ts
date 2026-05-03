import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { applyMigrations } from "../db-helper";
import {
  organizations,
  sources,
  releases,
  fetchLog,
  sourceChangelogFiles,
  sourceChangelogChunks,
  releaseSummaries,
  mediaAssets,
  webhookSubscriptions,
} from "@buildinternet/releases-core/schema";
import { adminOrgDependentsRoutes } from "../../workers/api/src/routes/admin-org-dependents";

function mkDb() {
  const sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  return drizzle(sqlite);
}

function mkApp(db: any) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as any).set("db", db);
    await next();
  });
  app.route("/", adminOrgDependentsRoutes);
  return app;
}

const NOW = "2026-05-03T00:00:00Z";

async function seed(db: any) {
  await db.insert(organizations).values({
    id: "org_acme",
    name: "Acme",
    slug: "acme",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(sources).values([
    {
      id: "src_a",
      orgId: "org_acme",
      name: "Acme Site",
      slug: "acme-site",
      type: "scrape",
      url: "https://acme.test/changelog",
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: "src_b",
      orgId: "org_acme",
      name: "Acme Blog",
      slug: "acme-blog",
      type: "feed",
      url: "https://acme.test/feed",
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);
  await db.insert(releases).values([
    { id: "rel_1", sourceId: "src_a", title: "v1", content: "first", contentHash: "h1" },
    { id: "rel_2", sourceId: "src_a", title: "v2", content: "second", contentHash: "h2" },
    { id: "rel_3", sourceId: "src_b", title: "v3", content: "third", contentHash: "h3" },
  ]);
  await db.insert(fetchLog).values([
    {
      id: "fl_1",
      sourceId: "src_a",
      releasesFound: 1,
      releasesInserted: 1,
      status: "success",
    },
  ]);
  await db.insert(sourceChangelogFiles).values({
    id: "scf_1",
    sourceId: "src_a",
    path: "CHANGELOG.md",
    filename: "CHANGELOG.md",
    url: "https://acme.test/CHANGELOG.md",
    rawUrl: "https://raw.acme.test/CHANGELOG.md",
    content: "# Changelog",
    contentHash: "h_scf",
    bytes: 11,
  });
  await db.insert(sourceChangelogChunks).values({
    id: "scc_1",
    sourceChangelogFileId: "scf_1",
    sourceId: "src_a",
    offset: 0,
    length: 11,
    tokens: 3,
    contentHash: "h_scc",
  });
  await db.insert(releaseSummaries).values({
    id: "rs_1",
    sourceId: "src_a",
    type: "rolling",
    summary: "summary",
    releaseCount: 2,
  });
  await db.insert(mediaAssets).values({
    id: "ma_1",
    sourceId: "src_a",
    r2Key: "media/ma_1.png",
    sourceUrl: "https://acme.test/img.png",
    contentType: "image/png",
    contentHash: "h_ma",
    byteSize: 1234,
  });
  await db.insert(webhookSubscriptions).values({
    id: "ws_1",
    orgId: "org_acme",
    sourceId: "src_a",
    url: "https://hook.test/webhook",
  });
}

describe("GET /admin/orgs/:slug/dependents", () => {
  it("returns full cascade scope for a populated org", async () => {
    const db = mkDb();
    await seed(db);
    const res = await mkApp(db).request("/admin/orgs/acme/dependents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      org: { id: string; slug: string; name: string };
      counts: Record<string, number>;
    };
    expect(body.org).toEqual({ id: "org_acme", slug: "acme", name: "Acme" });
    expect(body.counts).toEqual({
      sources: 2,
      releases: 3,
      fetchLog: 1,
      sourceChangelogFiles: 1,
      sourceChangelogChunks: 1,
      releaseSummaries: 1,
      mediaAssets: 1,
      webhookSubscriptions: 1,
    });
  });

  it("returns zeroed dependents for an org with no sources", async () => {
    const db = mkDb();
    await db.insert(organizations).values({
      id: "org_empty",
      name: "Empty",
      slug: "empty",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const res = await mkApp(db).request("/admin/orgs/empty/dependents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: Record<string, number> };
    expect(body.counts.sources).toBe(0);
    expect(body.counts.releases).toBe(0);
    expect(body.counts.webhookSubscriptions).toBe(0);
  });

  it("returns 404 for unknown org", async () => {
    const db = mkDb();
    const res = await mkApp(db).request("/admin/orgs/missing/dependents");
    expect(res.status).toBe(404);
  });

  it("resolves by org id including tombstoned orgs", async () => {
    const db = mkDb();
    await db.insert(organizations).values({
      id: "org_dead",
      name: "Dead",
      slug: "dead--org_dead",
      deletedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const res = await mkApp(db).request("/admin/orgs/org_dead/dependents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { org: { slug: string } };
    expect(body.org.slug).toBe("dead--org_dead");
  });
});
